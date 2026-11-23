# ADR-0049: Wait for a build slot, and retry terminal transactions cancelled by a conflict

- Status: Accepted
- Date: 2026-11-23
- Amends: ADR-0021 (what a build over the concurrent build limit does)
- Deciders: Dave Roberts (SA)

## Context
Every CodeBuild project of the control plane caps concurrent builds at
`concurrentBuildLimit` (M17, ADR-0021, ADR-0046). CodeBuild does not queue a
start over the cap. It refuses `StartBuild` with
`CodeBuild.AccountLimitExceededException` and creates no build (spec H-9).
The hook runner already waits on that refusal (R-46). The two script build
tasks did not: a refused start went straight to the failure write, so a
wave of creates or deletes larger than the limit left the excess
`CREATE_FAILED` or `DELETE_FAILED`. The platform stress test saw 9 such
failures in one wave of 20 at a limit of 5 (issue #95).

Concurrent operations on one cell meet in DynamoDB. Each terminal write of a
deployment or a cell is a `TransactWriteItems` that also updates the cell,
account, application or tenant item. Two of them at once can cancel one
with `TransactionCanceledException` and a `TransactionConflict` reason. A
cancelled transaction applies nothing, and the same transaction succeeds a
moment later. The workflow never retried a cancellation, so the record
ended `*_FAILED` although its build succeeded (issue #96, the workflow
side).

A Step Functions `Retry` matches the error name only. The name of a
cancellation is the same whatever its reasons: a conflict, or a failed
condition such as the replay of a delete that already committed. Each
execution's terminal transactions carry a stable `ClientRequestToken` and
item-state conditions, so a repeat is safe (ADR-013).

## Options considered
### Option 1: Retry both in the task's `Retry` list
The build tasks retry `CodeBuild.AccountLimitExceededException` every 30
seconds with full jitter, 40 times. Each wait is picked between 0 and 30
seconds, so the wait is about 10 minutes and never more than 20. The
terminal transactions retry `DynamoDb.TransactionCanceledException` 5 times
from 1 second, backoff rate 2, full jitter: at most 31 seconds of waits.
Pros: no loop; the Catch stays as it is, and the failure path gains one
`Choice` rule and one `Pass` state per build (tenant and cell) that set
the reason; the history grows by about three events per try (about 120
for a start refused for its whole wait). Cons: a cancellation by a
failed condition is retried too and fails the same way, so it reaches the
Catch up to 31 seconds later.
Waiting executions are served in no order, so a deployment started early
can wait while a later one starts.

### Option 2: A Catch, a check of the cause, a Wait and a loop
The build task catches the refusal and loops through a `Wait` state, as the
hook runner does (R-46). The transactions catch the cancellation, parse its
`Cause` for `TransactionConflict` and loop only then. Pros: a failed
condition is never retried; the build wait can be cut by a deadline, not a
count. Cons: three or four new states per task and per transaction, nine
places in all (four build states, five transactions); the `Cause` parse
must never fail itself, or no failure write runs (P-9).

### Option 3: No wait in the workflow
Document that a client keeps its in-flight creates, updates and deletes at
or below the limit, and that a cancelled terminal write is retried by
another operation, as the stress driver does (stress ADR-0013). Pros: no
change. Cons: every client must pace itself, and a record with a successful
build still reads `*_FAILED`.

## Decision
Option 1. Two `Retry` entries cover all four build states
(`RunTenantBuild`, `RunTenantBuildPinned`, `RunCellBuild`,
`RunCellBuildPinned`) and every terminal write, with no new loop to get
wrong. A failed condition costs at most 31 seconds more before its Catch,
which is the price of a `Retry` that cannot read the reasons. The build-slot
wait sends no idempotency token: a refused start creates no build, and the
token's behaviour at the account's quota is unverified (spec H-9). A start
still refused when its wait ends gets a `statusReason` that names the
refusal, not the generic build failure.

The wait bounds a burst. It is not a queue: a wave far larger than the
limit, for example 200 builds at a limit of 5, still fails its last starts.
Such a client keeps its waves near the limit.

## Consequences
- A wave over the limit waits for free slots, for about 10 minutes per
  start. The record stays `CREATING`, `UPDATING` or `DELETING` while it
  waits.
- Step Functions starts a task's `TimeoutSeconds` again on each attempt,
  so the wait is outside the one-hour build budget. The execution's worst
  cases at the caps grow by 20 minutes per script build: 1,520 minutes for a
  delete and 1,100 for a new-cell create, inside the 26-hour execution
  timeout (R-23).
- Each waiting execution calls `StartBuild` about every 15 seconds. A
  throttled `StartBuild` fails with `CodeBuild.AWSCodeBuildException`, an
  error name the wait does not match, so the operation fails at once with
  the generic reason. At 15 seconds per call a wave adds one call a second
  per 15 waiting executions, far below the rate where H-11 saw throttling;
  a wave of hundreds can reach it, which is one more reason to keep large
  waves near the limit.
- The global hook builds keep their own 5-minute refusal window (R-46). A
  hook start refused for all of it still fails the hook and its operation.
- The typed single-item writes and the record-event writes (R-50) carry the
  same retry list. They raise no `TransactionCanceledException`, so the new
  entry never matches there; a write that meets a transaction in flight
  raises `TransactionConflictException` and gets the transient retry.
- The API side of issue #96 (a cancelled placement answered as an
  ambiguous 500) is not covered here.
- Revisit if waves need an order (a queue in front of `StartExecution`), or
  if the wait must follow a deadline rather than a count.

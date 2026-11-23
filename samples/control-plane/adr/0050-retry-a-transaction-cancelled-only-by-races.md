# ADR-0050: Retry a transaction cancelled only by races

- Status: Accepted
- Date: 2026-11-23
- Amends: ADR-0013 (the ambiguous-outcome rule of placement)
- Deciders: Dave Roberts (SA)

## Context
The service writes five `TransactWriteItems` shapes: the placement into an
existing cell and the new-cell placement (spec §7.1 steps 2 and 3), the
paired `CREATE_FAILED` compensation of a new cell whose `StartExecution` was
refused (§7.4), and the hook create and delete, which share the hook counter
item (R-39). ADR-0013 classifies a cancelled placement by the position of its
failed conditions and treats anything else as ambiguous: the request fails
and the deployment is never retargeted.

Concurrent writes on one item cancel a transaction with the reason
`TransactionConflict` and no failed condition. Nineteen placements at once on
one cell, the shape of the stress test's onboarding wave, meet on the cell
item; two of them answered 500 "Deployment placement failed ambiguously". A
cancelled transaction applied nothing, so that outcome was never ambiguous.
The compensation has a worse failure: a conflict there leaves a new cell and
its deployment `CREATING` with no execution to move them.

DynamoDB cancels a member for capacity too: `ThrottlingError` and
`ProvisionedThroughputExceeded`. Those also applied nothing. A transaction
with a member that failed its condition (`ConditionalCheckFailed`) is
classified by position, as ADR-0013 decides. Two neighbouring errors are not cancellations:
`TransactionConflictException` is thrown by a single-item write that meets a
transaction in flight, which these five callers never send; and
`TransactionInProgressException` is thrown when the same
`ClientRequestToken` is still in flight, whose outcome may still be a commit.

## Options considered
### Option 1: Classify a race as a lost placement race
Reuse `PlacementRaceLostError`: the claim loop moves to the next candidate and,
after five attempts, creates a new cell (ADR-0031). Pros: no new error and no
wait. Cons: the cell lost no slot, it may still have room. A burst onto one
cell would move to other cells and then create cells it does not need, and a
full fleet would answer a 409 that names no race. It does nothing for the
compensation or the hooks.

### Option 2: Send the same transaction again, then answer a retryable 409
A cancellation whose every reason is `None` or a race code is sent again on
the same candidate, a few times with full jitter, inside the API's 29-second
window. When every attempt races, the repository throws
`TransactionRaceError` and the service answers `ConflictError` with the retry
hint of R-14: nothing was written, so the caller's retry can succeed. One
classifier and one retry helper serve all five callers. Pros: a race costs a
few hundred milliseconds instead of a failed request; the compensation does
not strand records on a single race; no cell is created for a race. Cons: a hot
cell item adds up to 350 ms of waiting to a request, and a placement under a
sustained burst can still answer the 409.

### Option 3: Answer the 409 at once, with no retry
Classify a race-only cancellation as `TransactionRaceError` on the first
attempt. Pros: the smallest change; the answer is correct. Cons: the caller
does all the retrying, so a wave of creates turns most races into 409s; and
the compensation has no caller to retry it, so a race still strands the
records.

## Decision
Option 2. `isRaceCancellation` (in `src/shared/repository.ts`, beside
`cancellationCodes`) is true when at least one member carries
`TransactionConflict`, `ThrottlingError` or `ProvisionedThroughputExceeded`
and every other member `None`. `sendTransactionWithRaceRetry` sends the
transaction at most 4 times, waiting a random time up to 50, 100 and 200 ms
between attempts, and then throws `TransactionRaceError`. A placement keeps
its candidate across the attempts; it is not a lost race, because the cell
lost no slot.

The first attempt carries the caller's `ClientRequestToken`; each later
attempt carries the token with the suffix `-r<attempt>`. A race-only
cancellation is a definite answer that applied nothing, so a new token cannot
apply the transaction twice, and it never meets whatever DynamoDB recorded for
the cancelled attempt's token. The CreateDeployment idempotency item (ADR-017)
is part of every attempt and is written only by the one that commits.

`TransactionConflictException` and `TransactionInProgressException` are not
covered: the first does not arise on these calls, and the second may still
end in a commit, so it stays ambiguous. The workflow's terminal writes run in
Step Functions and are outside this decision.

## Consequences
CreateDeployment answers a race-only cancellation, once its attempts are
spent, with a 409 whose message carries the retry hint, never a 500.
PutHook and DeleteHook answer the same 409. The paired compensation is sent
again on a race, so it strands the records only when every attempt races; the
compensation stays best-effort (ADR-011). A cancellation with every reason
`None`, a failed condition in a position the classifier does not name, and
any other error stay ambiguous, as ADR-0013 decides. Revisit the attempt count
if a placement burst larger than the stress test's waves answers the 409 often.

`scripts/conflict-probe.sh` shows the decision on a live control plane: it
sends one `CreateDeployment` per tenant at once onto one cell and counts each
call's first answer (no 500; any 409 carries the retry hint), the end state
of every accepted deployment, and any record a refused call left behind. Its
header lists the verbs (`deploy`, `setup`, `burst`, `reset`, `clean`) and the
environment they read; run it with no verb for the usage line.

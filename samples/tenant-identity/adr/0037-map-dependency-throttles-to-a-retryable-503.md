# ADR-0037: Map dependency throttles to a retryable 503

- Status: Accepted
- Date: 2026-11-10
- Deciders: Dave Roberts (SA)

## Context
The platform and tenant APIs map every error that is not a modelled domain error to `InternalServerError` 500 with a fixed message, so that no dependency text or input reaches the caller (spec N-6, N-7). A Cognito throttle took that path too. Seeding the agentic-runtime-isolation stress test on 2026-11-09 drove `CreateTenant` at 8 requests a second, under the route's 10 rps stage throttle, and 139 of 180 calls came back 500: each `CreateTenant` makes several Cognito control-plane calls (group, admin user, attributes), so Cognito's user-write category fills before API Gateway's throttle does. The caller could not tell a throttle from a bug, got no `Retry-After`, and a client that retries only 429 and 503 gave up. The token exchange already treats Cognito throttling as retryable (`server_error`, §5.4); the REST APIs did not.

## Options considered
### Option 1: A modelled `ThrottlingError` 503 with `Retry-After`
Add one error shape to the model, bound at the service level of both REST services, raised when the SDK error name is one of the dependency throttle names, with `@retryable(throttling: true)` and a `Retry-After` header. Pros: the status says what happened and what to do; generated clients back off; the message stays fixed; nothing else in the mapping changes. Cons: one more error shape; a fixed list of SDK error names to keep.

### Option 2: 429
Pros: the status most clients already retry. Cons: 429 says the *client* exceeded its quota; here the caller was inside its own quota and the server's dependency was not. API Gateway already answers 429 for the stage and usage-plan throttles, so a 429 from the function would blur two different causes.

### Option 3: Retry inside the function
Pros: hides the throttle from the caller. Cons: the slowest platform operation already takes seconds, a retry loop inside a synchronous Lambda spends the gateway's 29 s window on waiting, and a caller that paces itself is the right fix for a sustained overrun (the stress seed now runs at 4 a second). Server-side retries can be added later behind this error, not instead of it.

### Option 4: Leave the 500 and document it
Cons: a 500 for a condition the caller can clear by waiting is wrong, and it hides a pacing problem behind an alarm.

## Decision
Option 1. `src/shared/throttling.ts` names the SDK errors that mean "refused for rate" (Cognito `TooManyRequestsException`, `LimitExceededException`; DynamoDB `ProvisionedThroughputExceededException`, `RequestLimitExceeded`; the generic `ThrottlingException`). The platform service's `mapErrors` and the tenant API's `toModeledError` throw `ThrottlingError` (503, `Retry-After: 1`, fixed message) for them, after the modelled-error pass-through and before the unknown-error fallback. The platform service logs the case at `WARN` with the operation, tenant id and SDK error name, not at `ERROR`: nothing is broken in the function, so a log search for `ERROR` keeps pointing at bugs. The API's 5XX alarm (M-31) still counts a 503, on purpose: a sustained dependency throttle is a capacity signal the operator should see. `LimitExceededException` is in the list because Cognito raises it for request-rate limits as well as resource limits and the token exchange already treats it as retryable.

## Consequences
Clients that retry 429 and 503 keep going; `Retry-After` gives the wait. Spec §5.3 gains the row, the README's error sentence names it, `architecture.md` records the mapping. A throttle during `CreateTenant` still runs the compensation (the `PROVISIONING` row is deleted) and then surfaces as the 503. Revisit if a dependency's quota failure that does not clear by waiting (an account resource limit) shows up under one of these names in practice; it would then need a terminal error of its own.

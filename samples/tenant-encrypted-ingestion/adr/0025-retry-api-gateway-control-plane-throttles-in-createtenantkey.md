<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0025: Retry API Gateway control-plane throttles in CreateTenantKey

- Status: Accepted
- Date: 2026-11-09
- Deciders: Dave Roberts (PSA)

## Context
With `tenantThrottle` on, `CreateTenantKey` creates the tenant's API key
and adds it to the usage plan (ADR-0011): `GetUsagePlans`, `CreateApiKey`,
`GetApiKeys` on a conflict, and `CreateUsagePlanKey`. The API Gateway
control plane has a low per-account rate limit, shared with every stack
that deploys API Gateway resources in the account. On the integration run
of 2026-11-06, beside a parallel deploy in the same account, `CreateApiKey`
threw `TooManyRequestsException`; the SDK's three quick retries span about
a second and gave up, and the operation answered 500 with nothing in the
log but the 500, because the handler logged no unmodelled error.

## Options considered
### Option 1: Rely on the SDK's retries
Pros: no code. Cons: three retries in about a second do not outlast a
neighbouring deploy, as the run showed; the caller sees a 500 and must
guess that a retry is safe.
### Option 2: Own backoff on throttles in the key factory
Retry only a throttle, with exponential backoff, a bounded number of times.
Pros: rides out a burst of seconds; any other error still fails at once;
the row stays `CREATING` if the budget runs out, so a repeated
`CreateTenantKey` resumes (ADR-0004). Cons: the request can take up to
about 15 s longer; the bound must stay well inside the function timeout.
### Option 3: Move key creation out of the request path
An asynchronous job creates the API key after `CreateTenantKey` returns.
Pros: the caller never waits on the control plane. Cons: a tenant whose key
row is `ACTIVE` but whose API key does not yet exist is refused by API
Gateway; a queue, a retry policy and a state to model for one call per
onboarding.

## Decision
Option 2. `retryThrottled` (`src/shared/errors.ts`) retries an error that
is a throttle (`TooManyRequestsException`, `ThrottlingException`, or HTTP
429) with backoff of 1, 2, 4 and 8 s over five tries, and rethrows any
other error at once. `ensureApiKey` in `src/platform/create-tenant-key.ts`
wraps `GetUsagePlans`, `CreateApiKey`, `GetApiKeys` and
`CreateUsagePlanKey` in it. An error that is not a modelled `ApiError`
still becomes the SDK's 500, but the platform handler first logs it with
the operation, the tenant id and the error type only
(`src/platform/handler.ts`); the message is dropped by the logger's field
allowlist, so no request body or key value reaches the log.

## Consequences
Easier: onboarding survives a neighbouring deploy; a 500 that remains has
its error type in the log. Harder: a throttled `CreateTenantKey` can take
about 15 s more; other API Gateway control-plane callers in the same
account (another sample's runtime code, a parallel integration run) still
compete for the same quota, so two integration runs that deploy API
Gateway stacks should not run at once in one account. Revisit if API
Gateway raises the control-plane rate, if onboarding moves to a bulk job
(Option 3), or if the SDK's adaptive retry mode proves enough.

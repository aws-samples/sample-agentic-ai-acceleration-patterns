<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0022: Shape the API errors as built

- Status: Accepted
- Date: 2026-11-09
- Deciders: Dave Roberts (PSA)

## Context
The specification's error model (spec §5.3) was written before the
handlers. Building them showed cases it did not name or named differently:
a token without the route's scope needs an answer of its own; KMS reports
an exhausted on-demand rotation quota; a `tenant-key` key tagged for
another tenant is refused by the tenant role's identity policy before the
`KEYARN#` uniqueness check runs; and after offboarding the answer to
`CreateDelivery` depends on whether `tenantThrottle` is on (ADR-0011). The
model also declared an error no code path throws: `DeleteTenantKey` listed
`ConflictError`. Clients key on the response, so the model, the handlers
and the README must say the same thing.

## Options considered
### Option 1: Add an error shape per case
`RotationLimitReachedError`, `WrongTenantKeyError`, and so on. Pros: a
client can branch on `code` alone for every case. Cons: more shapes than
behaviours (each of these is a conflict or an unusable key the client
handles the same way); some would reveal why a key was refused, which
helps a prober map other tenants' keys.
### Option 2: Keep the shape set, document the answers as built
The existing shapes, with fixed messages distinguishing cases where a
client needs to. Pros: few shapes, one per client action; the model lists
exactly what each operation throws. Cons: a client that must tell a
rotation quota from another conflict reads the message prefix.

## Decision
Option 2. Every error response is `{code, message, requestId}`
(`src/api/errors.ts`); `code` is the Smithy shape name without the `Error`
suffix (`NotFoundError` is `NotFound`), except that the SSDK's
`ValidationException` and the model's `ValidationError` are both
`ValidationError`, and any unmodelled error is a 500 `InternalError`.
`Forbidden` (403) is this sample's addition: the token is valid but lacks
the route's scope (`ingestion/deliver` or `ingestion/read`), checked in the
handler (ADR-0011). `RotateTenantKey` answers 404 `NotFound` when the
tenant has no key row and 409 `Conflict` when the key is not `ACTIVE` or a
rotation is already in progress; an exhausted on-demand rotation quota is a
409 `Conflict` whose message starts `RotationLimitReached:`, not a code of
its own. `CreateTenantKey` with a `tenant-key` key tagged for another
tenant answers 422 `KeyNotUsable`: the tenant role's tag condition refuses
`DescribeKey` before the `KEYARN#` uniqueness check could answer 409.
After offboarding, `CreateDelivery` answers 403 from API Gateway when the
tenant's API key is gone (`tenantThrottle` on, once the usage-plan cache
lets go) or 409 `TenantKeyUnavailable` from the handler. Messages are fixed
strings chosen by the handler: they never echo input, a tenant id or a key
ARN. `DeleteTenantKey` declares no error: `ConflictError` was removed from
`model/platform.smithy` because no code path throws it; a half-done
offboarding is resumed by repeating the call (202, then 204).

## Consequences
Easier: one shape per client action; the model is the truth for what each
operation throws, so generated clients carry no dead branch. Harder: a
client that distinguishes the rotation quota from other conflicts matches a
message prefix, which is part of the contract and must not change without
a new record; the offboarding answer stays one of two. Revisit if a client
needs a machine-readable reason inside `Conflict` or `KeyNotUsable`, or if
API Gateway's usage-plan cache stops lagging a deleted key.

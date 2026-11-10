# ADR-0027: Verify the account handshake at registration

- Status: Accepted
- Date: 2026-11-09
- Amended by: ADR-0028
- Deciders: Dave Roberts (SA)

## Context
An account is usable only after its owner installed the role pair (ADR-025) with the right trust and external id. If that is wrong, the first build into the account fails minutes after `CreateTenant`, as `CREATE_FAILED` on a cell and a tenant that then need deleting. The operator who registered the account is present at `PutAccount` and gone by then.

## Options considered
### Option 1: Probe both roles at `PutAccount`, fail closed
The service assumes `<fleet>-cell-provisioning` and `<fleet>-tenant-provisioning` with the supplied `externalId`, discards the credentials, and returns 400 naming the role that refused. Pros: the error reaches the person who can fix it, synchronously. Cons: the API function needs AssumeRole on the role names in any account; a sync call to STS on the registration path.

### Option 2: Let the first build fail
Pros: no extra permission on the API function. Cons: the failure costs a cell build, two records in `CREATE_FAILED`, and a cleanup; the message is in a build log, not the API response.

### Option 3: Verify from the workflow at registration (async `PutAccount`)
Cons: turns a metadata write into a 202 with a transitional status, adding a state machine path for a check that takes under a second.

## Decision
Option 1. The probe is the whole check: no API call is made with the assumed credentials and nothing is written in the account (N-9). The API function's AssumeRole grant is bounded to the two fixed role names, the same bound the build roles carry; the API function already acts for fully privileged operators (ADR-015/018), so this does not widen who can reach the account, only lets registration fail early. The handshake failure is a `ValidationError` (400): the input names an account that is not ready.

## Consequences
A customer gets a clear, immediate signal that their stack is correct before anything is deployed into their account. The check is a point-in-time probe; a pair removed later surfaces as a build failure (ADR-025), not as a registration error, which is the right place for it. Revisit if a periodic health check of registered accounts is wanted; that would be a read-only sweep, not part of registration.

---

**Amended by ADR-0028 (2026-11-09):** the probe needs the pair to trust the API function's role; the role gets the physical name `<fleet>-api` and the pair's trust names it.

**Amended by ADR-0030 (2026-11-10):** when an external id is supplied, the probe also assumes each half without it and treats a success as a refusal; an STS failure other than `AccessDenied` is a 500 asking for a retry, not a refusal. The handshake failure is the model's `ValidationException` (the shape the Smithy validation model names; this record's `ValidationError` is the same 400).

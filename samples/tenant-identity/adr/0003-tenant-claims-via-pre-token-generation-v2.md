# ADR-0003: Put tenant identity into the access token with a V2 pre-token-generation trigger

- Status: Superseded by ADR-0020
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)

## Context
A service learns the caller's tenant from the token it receives (P-3,
P-6). Cognito puts `custom:*` attributes and `cognito:groups` into the **ID**
token by default; the access token carries neither unless a
pre-token-generation trigger adds them. Access-token customisation needs the
version 2 trigger event and the Essentials or Plus feature plan (Lite needs
advanced security features enabled).

## Options considered
### Option 1: Services accept the ID token and read `custom:tenantId` / `cognito:groups`
Pros: no trigger. Cons: ID tokens are meant for the client, not for APIs;
`aud` is the client id and there is no `scope`; the sample would teach a
pattern it should not.
### Option 2: Services look up tenant membership on every request
Pros: always current. Cons: a second source of truth on the request path,
which the problem statement argues against (spec §1); a Cognito or table
call per request, against admin API quotas.
### Option 3: A V2 pre-token-generation trigger writes the tenant claims and scopes into the access token
Pros: verifiable offline; one small pure function shared by every pool; the
same claim names in every topology. Cons: a Lambda invocation per issuance;
the feature-plan requirement (Essentials is the default for new pools, so
no extra configuration, but it must be stated); the total size of trigger
changes is quota-bounded (5,000 total changes).

## Decision
Option 3. One trigger function is attached to every pool the sample creates.
It emits `tenant_id` (topologies 1 and 2, and every narrowed token) or
`tenants` (topology 3) and the sample scopes, on the access token only. The
ID token is untouched and no group overrides are made (spec §8). In
`pool-per-tenant` the trigger maps the event's `userPoolId` to the tenant
through the registry, so `iss` and `tenant_id` always agree (spec §7.1).
The trigger is the only code that decides what tenant identity a token
carries: offboarding (ADR-0008), narrowing (ADR-0010), and the admin scope
(ADR-0015) are rules inside it.

## Consequences
Easier: the claim is uniform across topologies; the trigger is
unit-testable as a pure function. Harder: pools must stay on Essentials or
Plus, and the README's hardening checklist notes the cost. Revisit if
Cognito adds native group or attribute claims to access tokens; the trigger
would then shrink to the status, narrowing, and admin rules.

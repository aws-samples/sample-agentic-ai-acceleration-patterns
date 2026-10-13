# ADR-0004: Put the tenant claim into the access token with a V2 pre-token-generation trigger

- Status: Accepted
- Date: 2026-10-13
- Deciders: Dave Roberts (SA)

## Context
The resolver must learn the caller's tenant(s) from the token (P-3). Cognito
puts `custom:*` attributes and `cognito:groups` into the **ID** token by
default; the access token carries neither unless a pre-token-generation
trigger adds them, and access-token customisation requires the version 2
trigger event and the Essentials or Plus feature plan (Lite needs advanced
security features enabled).

## Options considered
### Option 1: Accept the ID token at the API and read `custom:tenantId` / `cognito:groups`
Pros: no trigger. Cons: ID tokens are meant for the client, not for APIs;
`aud` is the client id and there is no `scope`; the sample would teach a
pattern it should not. The `token_use` check in P-2 exists to refuse this.
### Option 2: Resolve tenant membership from Cognito on every request (`AdminListGroupsForUser`)
Pros: always current. Cons: a Cognito call on the request path, against the
`UserAuthentication`/admin API quotas; breaks P-2 (offline verification).
### Option 3: V2 pre-token-generation trigger writing `tenant_id` / `tenants` into the access token
Pros: offline-verifiable; one small pure function shared by every pool;
the same claim names in all topologies so the resolver's topology-specific
step is one line (spec §5.3 step 4). Cons: a Lambda invocation per sign-in;
feature-plan requirement (Essentials is the default for new pools, so no
extra configuration, but it must be stated); the total size of trigger
changes is quota-bounded (5,000 total changes).

## Decision
Option 3. One trigger function attached to every pool the sample creates,
emitting `tenant_id` (topologies 1 and 2) or `tenants` (topology 3) on the
access token only, nothing on the ID token, no scope or group overrides
(spec §8). In `pool-per-tenant` the resolver trusts the issuer lookup over
the claim and rejects a mismatch (spec §7.1).

## Consequences
Easier: resolution is offline and uniform; the trigger is unit-testable as a
pure function. Harder: pools must stay on Essentials or Plus; the README's
hardening checklist notes the cost dimension. Revisit if Cognito adds native
group or attribute claims to access tokens, which would retire the trigger.

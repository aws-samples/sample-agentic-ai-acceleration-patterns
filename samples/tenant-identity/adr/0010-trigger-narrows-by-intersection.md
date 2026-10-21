# ADR-0010: Narrow in the pre-token-generation trigger by intersecting the request with what the user holds

- Status: Accepted
- Date: 2026-10-20
- Deciders: Dave Roberts (SA)
- Supersedes: ADR-0003, ADR-0008

## Context
ADR-0003 put the tenant claims into the access token with a V2
pre-token-generation trigger and ruled out scope overrides. ADR-0008 made the
same trigger enforce offboarding and said it never reads `clientMetadata`.
Token exchange (ADR-0009) needs the trigger to read a narrowing request from
`clientMetadata` and to set the token's scopes. Both earlier records are
replaced by this one, so that one record states the whole trigger contract.
Their substance is carried over unchanged: claims on the access token only,
by a V2 trigger, on the Essentials plan; offboarding enforced on every
issuance from an uncached registry read.

`clientMetadata` is caller input. Anyone who holds a refresh token can call
`GetTokensFromRefreshToken` directly with any metadata, without going through
the exchange endpoint.

## Options considered
### Option 1: The exchange function checks membership; the trigger copies the request
Pros: simple trigger. Cons: the trigger would trust caller input, so a direct
Cognito call could name any tenant. That breaks P-3. The exchange function
would also need `cognito-idp` and registry permissions.
### Option 2: The trigger intersects the request with what the user holds, and refuses unless the result is exactly the request
Pros: safety lives in one place that already reads the registry. The
exchange endpoint needs no privilege. A direct Cognito call gets the same
answer as the endpoint. Cons: more logic in the trigger. Its refusal reaches
the endpoint only as the message of a Cognito exception, so the endpoint maps
error codes by message prefix.
### Option 3: The trigger intersects silently and issues whatever overlaps
Pros: never fails. Cons: a client that asks for tenant A can get a token
without it and fail later, far from the cause. RFC 8693 expects
`invalid_target` / `invalid_scope` instead.

## Decision
Option 2. The trigger contract (spec §8):

- V2 event, access token only, ID token untouched, Essentials plan
  (from ADR-0003).
- Tenant set: from the pool (1), `custom:tenantId` (2), or `t-<ULID>` groups
  (3). Every tenant is read from the registry on every invocation, uncached.
  Absent or non-`ACTIVE` tenants are refused (1, 2) or dropped (3); an empty
  set fails issuance (from ADR-0008).
- Without a narrowing request: emit `tenant_id` (1, 2) or `tenants` (3),
  and add the sample scopes (§8.1).
- With a narrowing request (`clientMetadata` keys of §8.2): the requested
  tenant must be in the tenant set, or the trigger throws `invalid_target`.
  The requested scopes must be a non-empty subset of the sample scopes, or it
  throws `invalid_scope`. It then emits `tenant_id` = the requested tenant
  and no `tenants` claim, adds exactly the requested scopes, and suppresses
  `aws.cognito.signin.user.admin`.
- No other `clientMetadata` key is read, and nothing in it can add a tenant
  or a scope that is not already held.

## Consequences
Easier: "narrowing never widens" is a property of one pure function. It can
be tested exhaustively at unit level, and at integration level by calling
Cognito directly and bypassing the endpoint (§10 step 6a). Harder: the
exchange function maps trigger errors by message prefix. The trigger's unit
tests must pin the prefixes. ADR-0003's revisit trigger still applies: native
group or attribute claims in access tokens would shrink the trigger to the
narrowing and status rules.

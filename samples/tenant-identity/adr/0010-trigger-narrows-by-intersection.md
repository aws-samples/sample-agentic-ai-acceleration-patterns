# ADR-0010: Narrow in the pre-token-generation trigger by intersecting the request with what the user holds

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)

## Context
Token exchange (ADR-0009) asks Cognito for a narrowed token by passing the
requested tenant and scopes in `ClientMetadata` on
`GetTokensFromRefreshToken`. Cognito hands that metadata to the trigger
(ADR-0003), which must apply it. `clientMetadata` is caller input. Anyone
who holds a refresh token can call `GetTokensFromRefreshToken` directly with
any metadata, without going through the exchange endpoint.

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
Option 2. The narrowing rules (spec §8.2):

- The tenant set is computed as for any issuance, with the status rule of
  ADR-0008 applied.
- The requested tenant must be in that set, or the trigger throws
  `invalid_target`. In topologies 1 and 2 a missing tenant means the user's
  only tenant; in topology 3 it is an `invalid_target`.
- The requested scopes must be a non-empty subset of the scopes the user
  holds for that tenant (§8.1), or the trigger throws `invalid_scope`.
- On success it emits `tenant_id` = the requested tenant and no `tenants`
  claim, adds exactly the requested scopes, and suppresses
  `aws.cognito.signin.user.admin`.
- Only the two §8.2 keys are read, and nothing in them can add a tenant or a
  scope that is not already held.

## Consequences
Easier: "narrowing never widens" is a property of one pure function. It can
be tested exhaustively at unit level, and at integration level by calling
Cognito directly and bypassing the endpoint (§10 step 7). Harder: the
exchange function maps trigger errors by message prefix, and the trigger's
unit tests must pin the prefixes.

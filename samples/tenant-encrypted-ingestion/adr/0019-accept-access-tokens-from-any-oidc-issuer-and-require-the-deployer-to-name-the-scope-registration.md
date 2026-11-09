<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
-->
# ADR-0019: Accept access tokens from any OIDC issuer and require the deployer to name the scope registration

- Status: Accepted
- Date: 2026-11-09
- Amends: ADR-0011
- Deciders: Dave Roberts (PSA)

## Context
ADR-0011 claims that any compliant OIDC issuer works. As first built, it
did not. The verifier needed `client_id` and `token_use`, which are
Cognito's claims: an issuer that names the client in `aud` and marks an
access token with the RFC 9068 header `typ: at+jwt` was refused. And when
`identityApi` was unset, the construct read tenant-identity's published
parameters (`/application-plane/shared/identity/apiUrl` and
`platformInvokePolicyArn`) inside `ScopeRegistration` to find where to
register `ingestion/deliver` and `ingestion/read`. Sample standard §1.1
says a consumer's construct stays producer-agnostic: it takes what it
needs as props, and only the demo app and the integration test name the
producer. Unsetting a prop was enough to bind the construct to
tenant-identity.

## Options considered
### Option 1: Keep the default
`identityApi` stays optional and its default reads tenant-identity's
parameters. Pros: the demo and existing callers change nothing; the common
composition takes one prop fewer. Cons: violates §1.1, because the construct
names a producer; a deployer with another issuer who forgets the prop gets
a deploy-time failure on a parameter they never published, not a
synth-time error naming the prop.
### Option 2: Make `identityApi` required, with `'none'` to skip
`identityApi: IdentityApiProps | 'none'`, both fields of `IdentityApiProps`
required. Pros: the construct reads no parameter; the choice is explicit
and checked at synth; a deployer with another issuer says `'none'` and owns
the scopes. Cons: one more prop for every caller; the demo stack reads the
two parameters itself.
### Option 3: A separate construct for the scope registration
The ingestion construct never registers scopes; a second exported
construct does it for tenant-identity. Pros: the cleanest separation. Cons:
the ordering (no route live before its scopes exist) moves to the caller,
who can get it wrong; two constructs to wire for the common case.

## Decision
Option 2. `identityApi` is a required prop typed `IdentityApiProps |
'none'`; `IdentityApiProps` carries `apiUrl` and `platformInvokePolicyArn`,
both required, and the construct validates them at synth. `'none'` skips
`ScopeRegistration`: the deployer then owns the `ingestion/deliver` and
`ingestion/read` scopes and the `tenant_id` claim on their issuer. The
demo stack reads tenant-identity's two parameters and passes them. The
verifier (`src/shared/verifier.ts`) accepts the client from `aud` when
`client_id` is absent (when `client_id` is present it decides alone), and
the access-token mark from the header `typ: at+jwt` or
`application/at+jwt` when `token_use` is absent; a token with neither mark
is refused, so an ID token never drives the API. Signatures are RS256
only. `IdentityProps.allowedClientIds` holds the accepted `client_id` or
`aud` values.

## Consequences
Easier: the construct names no producer, so any issuer that serves a
discovery document, signs RS256 access tokens and carries `tenant_id`,
`sub` and `scope` can front it; the registration is a visible choice.
Harder: every caller passes `identityApi`; with `'none'` the scope
catalogue and the `tenant_id` claim are the deployer's to keep in step with
the routes; an issuer that signs with another algorithm (ES256, PS256) is
refused until the allowlist grows. The bring-your-own path is covered by
unit tests only: the integration run of 2026-11-09 used tenant-identity's
Cognito tokens. The repository-root `ARCHITECTURE.md` §2.1 token contract
is widened accordingly (`aud` beside `client_id`, `typ: at+jwt` beside
`token_use`). Revisit if a deployer needs another signing algorithm, or if
the composition gains a second scope catalogue the construct should know.

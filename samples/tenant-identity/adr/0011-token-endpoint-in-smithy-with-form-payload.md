# ADR-0011: Model the token-exchange endpoint in Smithy with a form-encoded blob payload

- Status: Accepted
- Date: 2026-10-20
- Deciders: Dave Roberts (SA)

## Context
RFC 8693 §2.1 requires `application/x-www-form-urlencoded` request bodies
and RFC 6749 §5.2 error bodies (`{"error": ..., "error_description": ...}`,
HTTP 400). The sample's API is generated from a Smithy model with the
`restJson1` protocol, which serialises structures as JSON. The repository
standard asks for APIs to be defined in Smithy.

## Options considered
### Option 1: Wire `POST /oauth2/token` by hand, outside the Smithy model
Pros: full control of parsing and errors. Cons: the route is missing from
the model and the generated OpenAPI. A reader of the model does not see the
sample's only unauthenticated route.
### Option 2: A Smithy operation whose input is an `@httpPayload` blob with `@mediaType("application/x-www-form-urlencoded")`
The handler parses the form. The output is a JSON structure with
`Cache-Control: no-store` as an `@httpHeader`. One error shape,
`OAuthError`, carries `error` and `error_description` with
`@httpError(400)`. Pros: the route, its authorisation (none), its throttle,
and its output are all in the model and the OpenAPI. Cons: the form fields
are documented in the member docs, not typed. `restJson1` adds its
`X-Amzn-ErrorType` header to errors, which OAuth clients ignore.
### Option 3: Accept a JSON body
Pros: typed in Smithy. Cons: not RFC 8693. Standard OAuth client libraries
would not work against it.

## Decision
Option 2. The endpoint stays in the model, and the wire format stays
standard. Form parsing and validation are one function, unit-tested against
the RFC 8693 §2.1 parameter table.

## Consequences
Easier: one source of truth for every route. Harder: the form schema lives
in documentation and in the parser's tests. Revisit if the Smithy TypeScript
server SDK cannot serve a non-JSON blob payload. The fallback is Option 1,
with the route documented in the model's service docs.

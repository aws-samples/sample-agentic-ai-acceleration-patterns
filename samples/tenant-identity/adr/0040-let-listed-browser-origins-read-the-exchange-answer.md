# ADR-0040: Let listed browser origins read the exchange answer

- Status: Proposed
- Date: 2026-11-18
- Amends: ADR-0011
- Deciders: Dave Roberts (SA)

## Context
A single-page app that signs a user in with a `tenants` token (topology 3,
P-6) narrows it with `POST /oauth2/token` (§5.4) before it calls a backend.
The app is served from its own origin, so the call is cross-origin. The
`tenant-front-door` sample is such an app: it keeps tokens in memory, posts
the exchange from the browser, and serves either one host (`single` mode) or
one host per tenant under a domain (`host` mode)
([issue #56](https://github.com/aws-samples/sample-agentic-ai-acceleration-patterns/issues/56)).

The exchange is a CORS simple request: a form-encoded `POST` with no cookie
and no custom header, so the browser sends no preflight. It does send
`Origin`, and it lets the page read the answer only if the answer carries
`Access-Control-Allow-Origin` naming that origin. The API sends no CORS
header today, so the browser hides every answer and the app cannot narrow.

CORS is not access control for the endpoint. Any non-browser client can post
the form and read the answer; the refresh token in the body is the
credential (ADR-0011). CORS decides only which web pages may read an answer
to a request they sent. A page reaches a token only if it already holds the
user's refresh token.

## Options considered
### Option 1: Smithy `@cors` trait on the token service
Pros: declared in the model; the OpenAPI conversion adds the headers and an
`OPTIONS` mock route. Cons: the trait takes one origin, so `host` mode
cannot be expressed, and it adds a preflight route the simple request never
uses.
### Option 2: API Gateway gateway responses and method response mapping
Pros: headers on every answer, the gateway's own 429 and 5xx included.
Cons: the gateway can only send a fixed value or echo the request's
`Origin` unchanged. A fixed value cannot serve more than one origin; an
unconditional echo lets every page read the answer, which is what the list
exists to prevent.
### Option 3: The exchange function matches `Origin` against a deploy-time list
A stack input `allowedOrigins` lists exact origins and patterns of one DNS
label under a domain. The function compares the request's `Origin` with the
list and, on a match, adds `Access-Control-Allow-Origin` with that origin to
its answer, success and OAuth error alike. Pros: any number of origins, one
label of wildcard for `host` mode, no new route, the decision sits beside the
other request checks and is unit-tested there. Cons: answers the gateway
makes itself (throttle 429, integration timeout, a resource-policy refusal)
carry no header, so the page sees a network error and cannot read the
status.

## Decision
Option 3. It is the only option that serves a list and a one-label pattern
without letting an unlisted page read the answer. Option 2's echo was the
cheaper build but turns the list into a no-op. The gateway's own answers stay
unreadable to the page; a page treats a network error on the exchange as
retryable and keeps its refresh token, which is what §5.4 already asks of a
`server_error`. No `OPTIONS` route is added, because the simple request
never needs one. An empty list, the default, keeps today's behaviour: no
CORS header on any answer.

## Consequences
- §3.3 gains the `allowedOrigins` input, §5.4 a CORS subsection, §10 a step
  and §11 a seam for preflighted calls. The threat model gains T-38 and
  M-37.
- The integration stacks deploy with a list and check the header on a
  matching, an unmatched and a missing `Origin`.
- A deployer who reuses an existing `shared-pool-multi-tenant` stack for a
  browser app redeploys it with the context value; nothing else changes.
- `/platform/*` and `/tenant/*` stay without CORS. An app that calls
  `/tenant/*` from another origin, or adds a custom header to the exchange
  (which makes the browser preflight), needs an `OPTIONS` route that
  answers from the same list; that is the §11 seam.
- Revisit if API Gateway gains per-request matching of `Origin` against a
  list, which would cover the gateway's own answers too.

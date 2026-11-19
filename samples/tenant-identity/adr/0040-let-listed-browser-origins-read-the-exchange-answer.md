# ADR-0040: Let listed browser origins read the exchange answer

- Status: Accepted
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

The exchange can be a CORS simple request: a `POST` whose only non-default
request header is a CORS-safelisted `Content-Type`
(`application/x-www-form-urlencoded`), sent with `credentials` other than
`include`. The browser then sends no preflight. It does send `Origin`, and
it lets the page read the answer only if the answer carries
`Access-Control-Allow-Origin` naming that origin. The API sends no CORS
header today, so the browser hides every answer and the app cannot narrow.

CORS is not access control for the endpoint. Any non-browser client can post
the form and read the answer; the refresh token in the body is the
credential (ADR-0009). CORS decides only which web pages may read an answer
to a request they sent. A page reaches a token only if it already holds the
user's refresh token.

The integration is `aws_proxy` (`model/token.smithy`, `@integration`): the function's answer goes to the
caller as the function built it. Method response mappings do not apply to
it, and the gateway can add headers only to the answers it makes itself
(gateway responses), which apply to the whole API, `/platform/*` and
`/tenant/*` included.

## Options considered
### Option 1: Smithy `@cors` trait on the token service
Pros: declared in the model. Cons: the trait takes one origin, so `host`
mode cannot be expressed. Its OpenAPI conversion adds an `OPTIONS` mock
route and gateway-response headers, but cannot add a header to the
function's proxy answer, so the function would still have to set it.
### Option 2: Gateway responses that echo `Origin`
Pros: no code; covers the answers the gateway makes. Cons: covers none of
the function's answers (the 200 and every OAuth error), and a gateway
response can only send a fixed value or the request's `Origin` unchanged,
which lets every page read.
### Option 3: The exchange function matches `Origin` against a deploy-time list
A stack input `allowedOrigins` lists exact origins and patterns of one DNS
label under a domain. The function's entry compares the request's `Origin`
with the list and, on a match, adds `Access-Control-Allow-Origin` with that
origin to every answer it returns. Pros: any number of origins, one label of
wildcard for `host` mode, no new route, the decision is unit-tested beside
the other request checks. Cons: answers API Gateway makes itself (throttle
429, a resource-policy refusal, an integration failure) carry no header, so
the page sees a network error and cannot read the status.
### Option 4: Option 3 plus gateway responses that echo `Origin`
Pros: the page can read a 429 too. Cons: the gateway echo has no list, so
every page reads the gateway's answers on every route, against issue #56's
third ask (unlisted origins get no CORS header).

## Decision
Option 3. It is the only option that serves a list and a one-label pattern
and sends no CORS header to an unlisted page. The entry adds the headers
after the Smithy handler has built its answer, so they reach the 200, every
OAuth error and every framework error alike, outside the model; that is the
amendment to ADR-0011, together with the entry dropping media-type
parameters from `Content-Type` before dispatch, because a browser sending a
`URLSearchParams` body adds `;charset=UTF-8` and the generated deserializer
accepts only the bare type. A page treats a network error on the exchange as
transient, retries a bounded number of times and keeps its refresh token
(§5.4.1). No `OPTIONS` route is added. An empty list, the default, keeps
today's behaviour: no CORS header on any answer.

## Consequences
- §3.3 gains the `allowedOrigins` input, §5.4.1 the rules, §10 a step and
  §11 a seam for preflighted calls. The threat model gains T-38 and M-37.
- Synthesis applies the Public Suffix List rules, wildcard and exception
  rules and the private section included, to refuse a pattern such as
  `https://*.cloudfront.net`. The rules come from `tldts`
  (`allowPrivateDomains: true`), a dependency in `.projenrc.ts` imported
  only by the synth-time check, so it never reaches a function bundle. Its copy of the list is as current as the
  dependency version.
- The stack outputs `AllowedOrigins` (the entries joined with `,`) when the
  list is set. The integration stacks deploy with a fixed test list, and
  the e2e suite runs the CORS checks only against a stack whose output is
  that list, so a stack deployed without one, or with a real app's origins,
  skips them with a log line.
- A deployer who reuses an existing `shared-pool-multi-tenant` stack for a
  browser app redeploys it with the context value; the README's deploy
  commands show it.
- `/platform/*` and `/tenant/*` stay without CORS. A page that calls
  `/tenant/*` from another origin, or adds any non-safelisted header to the
  exchange (tracing headers from browser instrumentation included), makes
  the browser preflight and needs an `OPTIONS` route that answers from the
  same list; that is the §11 seam.
- ADR-0011 carries `Amended by: ADR-0040` and a dated trailing note.
- Revisit if API Gateway gains per-request matching of `Origin` against a
  list, which would cover the gateway's own answers too.

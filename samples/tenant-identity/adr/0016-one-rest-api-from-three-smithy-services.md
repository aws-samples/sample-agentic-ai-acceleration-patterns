# ADR-0016: Serve the three route families from one REST API built from three Smithy services

- Status: Accepted
- Date: 2026-10-21
- Deciders: Dave Roberts (SA)

## Context
Spec R-1 asks for one API Gateway API with three route families:
`/platform/*` (IAM), `POST /oauth2/token` (no authoriser), and `/tenant/*`
(Lambda authoriser). API Gateway offers two API types, REST and HTTP, and
the spec's other requirements decide between them. §3.2 grants the
platform API to the account through a resource policy, and HTTP APIs have
none. N-5, N-6 and N-7 set a separate throttle
per route family; both API types can do that, but only REST lets the
generated OpenAPI drive it per method. The reference sample
(`control-plane`) builds a REST `SpecRestApi` from Smithy's OpenAPI output,
and that path is proven in this repository.

Each route family also has its own function and role (P-8). The Smithy
TypeScript server SDK generates one handler per service, and a handler
must implement every operation of its service.

## Options considered
### Option 1: HTTP API from one Smithy service
Pros: cheaper per request, lower latency. Cons: no resource
policy; one generated handler would force all three functions to carry
every operation, or a hand-written router per function.
### Option 2: REST API from one Smithy service
Pros: resource policy, method throttling, request validation, same as
`control-plane`. Cons: the single-handler problem of Option 1 remains.
### Option 3: REST API from three Smithy services, merged
`PlatformService`, `TenantService`, and `TokenService`, one Smithy-build
projection each. Each function serves exactly one generated handler. The
stack merges the three OpenAPI documents into one REST API
(`src/shared/openapi.ts`) and points each path prefix at its function.
Pros: each function and role sees only its own operations; the model still
holds every route; one API URL. Cons: a merge step, and three generated
SDKs to build.

## Decision
Option 3. The resource policy and the role-per-route-family split are
spec requirements; the merge is a small, unit-tested pure function. The
token route keeps `security: []` and a parameters-only validator, because
API Gateway cannot validate a form body.

## Consequences
Easier: least privilege per function falls out of the model split; the
REST features (resource policy, WAF association, method throttling) are
available to a deployer. Harder: a REST API costs more per request than an
HTTP API, and the merge rejects duplicate paths or conflicting schema
names, so the three services must not reuse a path. Revisit if HTTP APIs
gain resource policies.

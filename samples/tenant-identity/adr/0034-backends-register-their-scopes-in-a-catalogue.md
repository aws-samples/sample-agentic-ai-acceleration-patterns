# ADR-0034: Let backends register their own scopes in a catalogue through the platform API

- Status: Proposed
- Date: 2026-10-29
- Deciders: Dave Roberts (SA)

## Context
The scopes a token may carry are three compile-time constants in
`src/shared/constants.ts` (`tenant-api/read`, `tenant-api/write`,
`tenant-admin/users`). Every tenant user holds the first two; the trigger
writes them, the token exchange accepts a subset of them, and nothing else
exists. A consumer such as the agentic-runtime-isolation sample can therefore
only *reuse* these names: its `billing` backend requires `tenant-api/write`,
which proves a token was narrowed, not that the user may reach billing.

The consumer's backends are hot-pluggable (its ADR-0024 adds a backend by a
registry write, with no ingress redeploy). Each backend owns one or more scopes
of its own, and a backend added after this stack was deployed must be able to
bring its scopes with it. The identity provider must know a scope before it
issues a token that carries it, so the catalogue of valid scopes has to be
writable after deploy.

## Options considered
### Option 1: A deploy-time prop `scopes` on `TenantIdentityStack`
The deployer lists every scope; the Lambdas read an env var. Pros: no new
resource, no runtime read. Cons: a new backend needs an identity redeploy,
which undoes the consumer's hot-plug story and couples two release trains.

### Option 2: A scope catalogue in the registry table, written through the platform API
A `Scope` resource on the platform service: `PUT /platform/scopes/{scope}`
(idempotent create), `DELETE /platform/scopes/{scope}`, `GET /platform/scopes`.
Rows `SCOPE#<name>` in the registry table beside the tenant rows. The owner of
a backend registers its scopes at deploy with a custom resource that calls the
API with SigV4, the way the control-plane mount does (ADR-0005, ADR-0030).
The trigger and the token exchange read the catalogue and cache it for 60 s.
Pros: a backend brings its scopes, the identity side never names a backend,
the catalogue is inspectable. Cons: one more resource and route set, one more
cached read on the token path, and `PlatformInvokePolicy` grows by the scope
routes.

### Option 3: Read the consumer's backend registry from this stack
The trigger lists `backends/*` in the consumer's SSM prefix and treats their
scopes as the catalogue. Pros: no new API. Cons: the identity provider would
import a consumer's data shape and parameter prefix, inverting the dependency;
a second consumer could not be served.

## Decision
Option 2. Scope names follow `<owner>/<action>` where `<owner>` is the
registering backend's name, so a scope is unique because the backend name is
(the consumer refuses a second backend of the same name). The catalogue
refuses a name that does not match `^[a-z0-9-]+/[a-z0-9-]+$`, a name whose
owner is `tenant-admin` (reserved for `tenant-admin/users`, which stays the one
built-in scope and keeps its group rule, ADR-0015), and a second registration
of the same name by a caller who gives a different `owner`. `DELETE` removes
the row; tokens stop carrying the scope within one cache period plus the access
token lifetime (5 min). The `tenant-api/read` and `tenant-api/write` constants
go: this stack's own integration test registers two scopes through the API and
narrows to them, which also tests the catalogue.

This amends ADR-0002: the registry holds tenants *and scopes*; Cognito remains
the only user store.

## Consequences
The token path gains one DynamoDB read every 60 s per Lambda container
(`Query` on `PK = SCOPE`); a read failure keeps the previous catalogue and
retries, and an empty catalogue at cold start refuses narrowing with
`invalid_scope` rather than issuing an un-narrowed token with no scopes.
`PlatformInvokePolicy` (ADR-0030) gains `PUT`/`DELETE /platform/scopes/*`;
`GET /platform/scopes` is reachable through it because execute-api ARNs cannot
exclude it, recorded in `threat-model.md`. A registered scope is not yet held
by anyone: entitlement is per tenant (ADR-0035) and per user (ADR-0036).

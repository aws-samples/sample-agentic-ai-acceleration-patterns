# Specification: Tenant Identity with Amazon Cognito, Three Topologies

> **Status:** This document is the *requirements and principles* layer of the
> tenant-identity sample: it states what a correct implementation must do and
> why, without prescribing every implementation detail. An implementer (human
> or LLM) should be able to build a functionally equivalent sample from this
> spec alone. Where a requirement is a deliberate design position rather than
> an obvious necessity, the reasoning is given inline; the spec is also a
> teaching document.

The keywords MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in
RFC 2119.

---

## 1. Problem Statement

Every multi-tenant application has to answer one question on every
request: **which tenant is this caller acting for, and is the caller allowed
to act for it?** Cognito answers the first half of that question for *users*
out of the box: a signed token proves who authenticated. It has no notion of a
tenant, but it offers three places where tenant information can be overlaid
onto a user pool: the pool itself, a user attribute, or a group. Whichever is
chosen, the overlay ends up inside the token the user presents, and that is
why the choice matters.

Once tenant identity rides in the token, **Cognito becomes the trusted source
of tenant identity**, not only of user identity. The application reads the
tenant from a claim that Cognito signed, so the claim carries the same
guarantee as the user's identity: it cannot be forged by the client, it can be
checked offline against the pool's public keys, and it is the same on every
request without a lookup. The alternative, keeping a user-to-tenant mapping in
an application table and consulting it per request, puts a second source of
truth on the request path that can drift from the directory and that every
service must be trusted to query correctly. Overlaying on Cognito instead
means tenant assignment is made once, at onboarding, by the party that
controls the user pool (the operator, P-8), and every service downstream
inherits it from the token (P-3, P-5).

The three overlays differ in how the tenant boundary is drawn, and the choice
shapes onboarding, offboarding, per-tenant customisation, what a consumer of
the token has to trust, and what happens when one person works for several
tenants.

This sample builds the three topologies **side by side** behind one
platform API, so that the trade-offs can be seen by running the same scenario
against each:

| Topology (context value) | Where the tenant boundary lives | A user can belong to |
|---|---|---|
| `pool-per-tenant` | One user pool per tenant; the token's issuer *is* the tenant | exactly one tenant per account |
| `shared-pool` | One user pool; the tenant is an immutable user attribute | exactly one tenant |
| `shared-pool-multi-tenant` | One user pool; tenants are groups (`t-<tenantId>`); a user may hold several | one or more tenants |

The topology is chosen **once, at deploy time**. The platform API and the
token contract are identical across topologies; only the strategy that
provisions tenant identity in Cognito differs (P-1).

**The sample stops at the token.** Its product is a Cognito access token that
carries tenant identity, issued and withdrawn by the identity provider. How a
service or gateway verifies that token and scopes a request to the tenant it
names is the consumer's design, not this sample's (§1.2, ADR-0009). The
integration test verifies the tokens with a standard library for one reason
only: to prove that the claim is present, correct, and the same shape in
every topology.

### 1.1 The deployment model

This is an **application-plane** sample: it is the identity layer a deployed
multi-tenant application uses to authenticate end users and to tell every
downstream service which tenant they act for. It assumes a **pooled
application plane** (one deployment serves many tenants) and shows how the
identity boundary can still be silo (`pool-per-tenant`) or pool
(`shared-pool*`) independently of the compute boundary. It complements the
`control-plane` sample, which deliberately treats customer identity as an
application-plane concern (control-plane ADR-004).

Two actor classes exist:

- **Operators** (the application provider) onboard tenants and manage users and
  memberships through the **platform API**.
- **End users** (tenant staff) authenticate against Cognito and receive tokens
  that carry their tenant. What they call with those tokens is outside the
  sample.

### 1.2 What this sample is NOT

Out of scope, deliberately:

- **Token consumption.** Verifying a token and scoping a request to the tenant
  it names belongs to the service or gateway that receives it: an API Gateway
  Cognito authoriser, a JWT authoriser, or an in-function verifier are all
  valid consumers, and the registry gives a `pool-per-tenant` consumer its
  issuer allowlist (§4.1). None of them is built here (ADR-0009, seam in §11).
- **A login UI.** Managed login / hosted UI, federation to tenant IdPs (SAML,
  OIDC, social), passwordless, MFA. Tokens are obtained with a server-side
  password flow for demonstration; the claims do not depend on how the token
  was issued.
- **Authorisation within a tenant.** Roles and permissions (`admin`,
  `member`) are an extension seam (§11), not built.
- **The vendor's own identity.** Operators authenticate to the platform API
  with IAM (SigV4); the vendor IdP question is answered by the
  `control-plane` sample.
- **A user directory of its own.** Cognito is the only user store (P-5).
- **Tenant migration between topologies**, billing, tiers, quotas per tenant.
- **A front door.** Routing a request to the right tenant deployment is the
  `tenant-front-door` sample.

### 1.3 Comparison the sample must make visible

| Dimension | `pool-per-tenant` | `shared-pool` | `shared-pool-multi-tenant` |
|---|---|---|---|
| Blast radius of a pool misconfiguration | one tenant | all tenants | all tenants |
| Per-tenant password policy, MFA, federated IdP | native (per pool) | not per tenant (one pool; per-tenant IdPs possible but share the pool's 300-IdP quota) | as `shared-pool` |
| A person in several tenants | separate accounts, separate sign-ins | not supported | supported (groups) |
| Onboarding cost | create pool + client + trigger (seconds, more moving parts) | create nothing in Cognito | create one group |
| Offboarding | delete pool: no new tokens, and the issuer disappears | stop issuance, then delete users, keep pool | stop issuance for the tenant, delete group; delete users whose only tenant it was |
| Issuers a consumer must trust | one per tenant; the registry is the allowlist | one | one |
| Hard ceilings (defaults, per Region) | 1,000 user pools (adjustable to 10,000) | 40,000,000 users per pool; 50 custom attributes | 10,000 groups per pool; 100 groups per user; 5,000 total changes in pre-token-generation output |
| Where the tenant lives in the token | `iss` (and `tenant_id`, which MUST agree) | `tenant_id` claim from `custom:tenantId` | `tenants` claim from `cognito:groups` |

Quota figures are from the Cognito quotas page at the time of writing; the
README MUST link the page rather than restate figures as permanent.

---

## 2. Guiding Principles

These principles generated every decision in the design. When this spec is
silent on a detail, resolve it by applying these principles; they are the
spec's extension mechanism and the facts the ADRs appeal to.

### P-1. One contract, three strategies

The operator sees one platform API and every consumer sees one token
contract (P-6), regardless of topology. Everything topology-specific lives
behind one strategy interface, the **provisioner**: what onboarding a tenant,
creating a user, changing a membership, and offboarding a tenant mean in this
topology, plus how the pre-token-generation trigger finds the tenant(s) for
an event (§8). An implementation MUST NOT let topology-specific branches leak
into handlers, the data model, or the API model. The test of the principle:
the integration scenario (§10) runs unchanged against all three stacks.

### P-2. The token is the product; offboarding is enforced at issuance

Nothing in the sample consumes the tokens it issues, so there is no request
path on which to check a tenant's status, and the sample MUST NOT invent one.
Offboarding is enforced where identity is issued, by the identity provider
and the trigger that shapes its tokens (ADR-0010):

1. `DeleteTenant` flips the tenant to `DELETING` in the registry before
   touching Cognito (R-9).
2. The pre-token-generation trigger refuses to add a `DELETING` or absent
   tenant to any token, on sign-in **and on refresh** (§8). A user whose only
   tenant is gone cannot obtain a new token; a multi-tenant user obtains one
   without that tenant.
3. The provisioner then removes what the tenant owned in Cognito: the pool,
   or the group and the users whose only tenant it was (P-4).

Access tokens already issued remain valid until they expire; the bound is the
access token lifetime (N-1, 5 minutes). The README MUST state that bound and
MUST say that a consumer needing a tighter one adds a status check of its
own, which is a consumer decision outside this sample.

### P-3. Tenant identity is a claim the caller cannot choose

The tenant a token names MUST be set by the operator through the platform API
and MUST reach the token only through Cognito: the issuing pool, an
attribute, or a group. Nothing the end user controls MAY influence it. In
`shared-pool` the attribute is created **immutable** and excluded from the app
client's writable attributes, so the user can neither change it nor set it at
sign-up (self sign-up is off in every pool, R-6). In `shared-pool-multi-tenant`
groups are admin-only by construction. The trigger MUST NOT read
`clientMetadata` or any other caller-supplied input when deriving the claim.
When a token names several tenants, which one a given request acts for is the
consumer's decision (§1.2); the token carries every membership and nothing
else.

### P-4. Onboarding and offboarding are symmetric and total

Every topology MUST implement all of: create tenant, delete tenant, create
user, delete user, add membership, remove membership. Where an operation has
no meaning in a topology (membership changes outside
`shared-pool-multi-tenant`) it MUST fail explicitly with
`UnsupportedInTopology` (400), not succeed as a no-op, so a deployer who
picks the wrong topology finds out from the API, not from a missing effect.
Delete tenant MUST remove everything create tenant and its users produced:
the pool (`pool-per-tenant`), or the group and the users whose only tenant
it was (`shared-pool*`). The integration scenario ends with no pools, groups,
or users attributable to the test.

### P-5. Cognito is the only user store

The sample MUST NOT persist users, memberships, or credentials in its own
table. Users live in Cognito; memberships are Cognito groups or attributes;
the registry holds **tenants only** (and, for `pool-per-tenant`, the
pool/issuer the tenant owns). Duplicating the user directory creates a second
source of truth that drifts; the trade is that listing "users of tenant X" is
a Cognito call, which is acceptable for a platform API that operators call
rarely.

### P-6. Minimal claims, stable shape

The access token carries at most two tenant claims added by the pre-token-
generation trigger: `tenant_id` (string, topologies 1 and 2) or `tenants`
(array of strings, topology 3). Nothing else is added: no names, no roles,
no e-mail. The claims go into the **access** token, not the ID token, because
the access token is what a client presents to an API; the ID token is for the
client itself. This is the **token contract**, the one thing a consumer may
rely on across topologies:

| Topology | Claim | Value | Also true |
|---|---|---|---|
| `pool-per-tenant` | `tenant_id` | the tenant's ULID | `iss` is the tenant's pool; the registry maps one to the other and the two MUST agree |
| `shared-pool` | `tenant_id` | the tenant's ULID | |
| `shared-pool-multi-tenant` | `tenants` | sorted array of ULIDs, length ≥ 1 | only groups named `t-<ULID>` contribute |

`sub`, `username`, `iss`, `client_id`, `token_use`, and `exp` are Cognito's
own and are not altered.

### P-7. Explicit deploy-time choice, fail fast

`topology` is a required CDK context value with exactly three accepted
strings. Synthesis MUST fail with a message listing the accepted values if it
is missing or misspelled. A topology is never inferred, defaulted, or
switched at runtime (ADR-0001).

### P-8. Least privilege expressed as role asymmetry

The platform function creates and deletes user pools, groups, and users; the
trigger function reads the registry and nothing else. They MUST be separate
functions with separate roles: the trigger role MUST NOT hold any
`cognito-idp:*` action (R-11), and the platform API MUST NOT be reachable
with an end-user token (IAM only, ADR-0007). In `pool-per-tenant` the
platform role necessarily holds `cognito-idp:CreateUserPool` and
`DeleteUserPool`, which are account-wide actions; this is the documented
hardening point of that topology (N-4).

### P-9. Say what each topology costs

Each topology trades isolation for operational simplicity in a different
place. The README MUST carry the comparison in §1.3 of this spec, kept true
after implementation, including the service quotas that bound each design,
because the quotas are the first thing a real deployment hits.

---

## 3. System Shape

### 3.1 Required components

| # | Component | Requirement |
|---|---|---|
| R-1 | **HTTP API** | One API Gateway HTTP API, generated from the interface model (Smithy), one route family: `/platform/*` with IAM authorisation (ADR-0007). No application routes (ADR-0009). |
| R-2 | **Platform function** | Implements the platform API through the topology's provisioner. Role per P-8. |
| R-3 | *Retired* | Was the application function. Removed with token consumption (ADR-0009). |
| R-4 | **Tenant registry** | One DynamoDB table (§4). Point-in-time recovery on; `DESTROY` removal for the sample. |
| R-5 | **Pre-token-generation function** | Cognito Lambda trigger, version 2 event (`V2_0`), adds the claim(s) of P-6 to the access token and enforces tenant status (P-2, §8). Attached to every pool the sample creates. Pools MUST use the **Essentials** feature plan (the default for new pools); access-token customisation is not available on Lite without advanced security features. |
| R-6 | **User pool(s)** | `shared-pool*`: exactly one pool created by the stack. `pool-per-tenant`: zero pools at deploy time; one pool, one app client, and the trigger attachment per tenant at onboarding. Every pool: self sign-up off, admin-create only, e-mail as username, access token lifetime 5 minutes (N-1), no hosted UI domain. |
| R-7 | **Parameter publication** | The stack publishes `/application-plane/shared/identity/{apiUrl,topology}` and, for `shared-pool*`, `/application-plane/shared/identity/userPoolId` and `appClientId`, so the sample mounts into the `control-plane` sample's shared namespace. |

### 3.2 Caller and identity model

- **Operator → platform API:** SigV4 with any principal the deployer grants
  `execute-api:Invoke` on `/platform/*`. The sample grants the deploying
  principal nothing implicitly; the integration test signs with its own
  credentials and the stack's resource policy allows the account.
- **End user → Cognito:** sign-in against the topology's pool yields access,
  ID, and refresh tokens; the access token carries the tenant (P-6). The
  sample defines no endpoint that accepts it.
- **Sign-in in the sample:** `ADMIN_USER_PASSWORD_AUTH` through
  `AdminInitiateAuth` from the platform function (`POST
  /platform/tenants/{tenantId}/users/{username}/token`) **for the
  demonstration only**, so the integration test can obtain real Cognito
  tokens without a browser (ADR-0008). This route MUST be documented as a
  test aid and the README's hardening checklist MUST say to remove it in
  production.
- **Verification in the test:** the integration test verifies every token it
  asserts on with a JWKS-based library (reference: `aws-jwt-verify`) against
  the issuer named by the registry (topology 1) or the published pool
  parameters (topologies 2, 3), the pool's app client, and
  `token_use == "access"`. This is test code, not sample code, and the README
  MUST say so.

### 3.3 Deployment inputs

| Context key | Required | Values / default | Effect |
|---|---|---|---|
| `topology` | yes | `pool-per-tenant` \| `shared-pool` \| `shared-pool-multi-tenant` | selects the provisioner (P-7) |

Synthesis MUST fail on an unknown `topology` with the accepted values in the
message. The stack name MUST embed the topology
(`TenantIdentity-<topology>`) so all three can coexist in one account and
Region, which the integration test relies on. No other input exists: the
former header-name and cache-TTL inputs went with token consumption
(ADR-0009).

---

## 4. Data Model

One table, `TenantRegistry`. Single-table, one item type.

### 4.1 Tenant

| Field | Requirement |
|---|---|
| `tenantId` | generated ULID |
| `name` | required; not unique |
| `status` | `ACTIVE` \| `DELETING` |
| `topology` | the stack's topology, stamped for diagnostics |
| `userPoolId`, `appClientId`, `issuer` | `pool-per-tenant` only: the tenant's own pool. `issuer` is stored for consumers: `ListTenants` is the issuer allowlist a `pool-per-tenant` verifier needs (§1.2). |
| `groupName` | `shared-pool-multi-tenant` only: `t-<tenantId>` |
| `createdAt`, `updatedAt` | ISO-8601 |

Key: `PK=TENANT#<tenantId>`, `SK=META`.

**R-8:** No user, membership, credential, or token material is ever written
to the table (P-5).

**R-9:** `DeleteTenant` MUST flip `status` to `DELETING` with a conditional
write *before* touching Cognito, so the trigger stops issuing tokens for the
tenant at once (P-2) even if the Cognito clean-up is slow or fails part-way.
The item is removed only after clean-up succeeds; a failed clean-up leaves a
`DELETING` tenant that `DeleteTenant` can be re-run against (idempotent,
P-4).

### 4.2 Pool index (`pool-per-tenant` only)

A GSI `byUserPoolId` on `userPoolId` → `tenantId`, so the trigger can map
the `userPoolId` of its event to the tenant with one read (§8). An event from
a pool not in the index is a pool the sample does not know; the trigger MUST
throw, so no token leaves such a pool with a tenant claim.

### 4.3 Listing

`ListTenants` scans the single table with pagination (the registry is
operator-scale, not user-scale). An implementation MAY add a status GSI; it
MUST NOT add a user item type to make listing users cheaper (P-5).

---

## 5. API Surface

Defined first in Smithy; OpenAPI, server SDK, and gateway wiring are
generated from the model.

### 5.1 Platform operations (`/platform`, IAM)

| Operation | Method / path | Effect by topology |
|---|---|---|
| `CreateTenant` | `POST /platform/tenants` `{name}` → 201 Tenant | 1: create pool + client + trigger, write registry. 2: write registry. 3: create group `t-<id>`, write registry. |
| `GetTenant` | `GET /platform/tenants/{tenantId}` | registry read |
| `ListTenants` | `GET /platform/tenants?nextToken=` | registry scan |
| `DeleteTenant` | `DELETE /platform/tenants/{tenantId}` → 204 | R-9, then: 1: delete pool. 2: delete users with `custom:tenantId=<id>`. 3: delete users whose only group is `t-<id>`, remove the group from the rest, delete the group. |
| `CreateUser` | `POST /platform/tenants/{tenantId}/users` `{email}` → 201 User | 1: `AdminCreateUser` in the tenant's pool. 2: `AdminCreateUser` with `custom:tenantId`. 3: `AdminCreateUser` (if absent) + `AdminAddUserToGroup`. Returns a temporary password only in the response, never logged. |
| `DeleteUser` | `DELETE /platform/tenants/{tenantId}/users/{username}` → 204 | 1, 2: `AdminDeleteUser`. 3: remove from `t-<id>`; delete the user if no `t-*` group remains. |
| `AddMembership` | `PUT /platform/tenants/{tenantId}/users/{username}/membership` → 204 | 3: `AdminAddUserToGroup`. 1, 2: 400 `UnsupportedInTopology`. |
| `RemoveMembership` | `DELETE /platform/tenants/{tenantId}/users/{username}/membership` → 204 | 3: `AdminRemoveUserFromGroup`; 409 if it is the user's last tenant (use `DeleteUser`). 1, 2: 400 `UnsupportedInTopology`. |
| `IssueToken` (test aid) | `POST /platform/tenants/{tenantId}/users/{username}/token` `{password}` → 200 `{accessToken, idToken, refreshToken, expiresIn}` | `AdminSetUserPassword` (permanent) then `AdminInitiateAuth` with `ADMIN_USER_PASSWORD_AUTH` against the topology's pool. §3.2. |
| `RefreshToken` (test aid) | `POST /platform/tenants/{tenantId}/users/{username}/token/refresh` `{refreshToken}` → 200 `{accessToken, idToken, expiresIn}` | `AdminInitiateAuth` with `REFRESH_TOKEN_AUTH`, so the test can show that refresh re-runs the trigger (P-2, §10 steps 6 and 7). Same labelling as `IssueToken`. |

Platform mutations are **synchronous**. The slowest, creating a user pool, is
seconds, not minutes; a 202/polling model would add machinery without adding
a capability (contrast control-plane P-8, where builds take minutes).

### 5.2 Application operations

None. The former `/app/whoami` route and the resolution algorithm that backed
it were removed with token consumption (ADR-0009); §5.3 is retired and its
number is not reused.

### 5.4 Error model

| Error | HTTP | Triggers |
|---|---|---|
| `ValidationError` | 400 | malformed input; `UnsupportedInTopology` |
| `ResourceNotFoundError` | 404 | unknown tenant or user |
| `ConflictError` | 409 | tenant `DELETING` on mutation; removing a user's last membership; e-mail already exists in a shared pool for a different tenant (topology 2) |
| `InternalServerError` | 500 | everything else |

401 and 403 on `/platform/*` are API Gateway's own (IAM); the sample emits
neither. **R-10** (opaque 401/403 bodies) is retired with the application
routes.

---

## 6. Contracts

### 6.1 What the deployer supplies

- The `topology` context value (P-7).
- Credentials with `execute-api:Invoke` on `/platform/*` for whoever operates
  tenants.
- Nothing else. No pre-existing pool, no domain, no certificate.

### 6.2 What the sample promises

- The token contract of P-6 on every access token issued by a pool the sample
  created, identical in shape across topologies.
- The platform API of §5.1 with the per-topology effects stated there,
  including explicit `UnsupportedInTopology` failures (P-4).
- No new token names a tenant once `DeleteTenant` has been accepted (P-2,
  R-9); tokens already issued expire within the access token lifetime (N-1).
- Clean teardown: `cdk destroy` after deleting all tenants leaves no pools,
  groups, users, parameters, or log groups with the sample's prefix.
- Parameters under `/application-plane/shared/identity/*` (R-7).

### 6.3 Parameter namespace

| Parameter | Topologies | Written by |
|---|---|---|
| `/application-plane/shared/identity/topology` | all | stack |
| `/application-plane/shared/identity/apiUrl` | all | stack |
| `/application-plane/shared/identity/userPoolId` | 2, 3 | stack |
| `/application-plane/shared/identity/appClientId` | 2, 3 | stack |

`pool-per-tenant` publishes no pool identifiers at the shared level because
pools are per tenant; a consumer resolves them through `GetTenant` or
`ListTenants`.

---

## 7. Topology Mechanics (normative detail)

### 7.1 `pool-per-tenant`

- `CreateTenant` creates a pool named `tenant-identity-<tenantId>`, one app
  client (no secret, `ALLOW_ADMIN_USER_PASSWORD_AUTH` and
  `ALLOW_REFRESH_TOKEN_AUTH` only, access token 5 min), attaches the shared
  pre-token-generation function (one function, many pools; the function
  grants `cognito-idp.amazonaws.com` invoke scoped to the account), and
  writes `userPoolId`, `appClientId`, `issuer` to the registry in one item.
- The trigger adds `tenant_id` from the registry: it maps the event's
  `userPoolId` to its tenant through `byUserPoolId` (§4.2). This keeps the
  claim name identical in topologies 1 and 2 so a consumer reads one claim
  in both; `iss` and `tenant_id` MUST agree, and the integration test asserts
  it.
- `DeleteTenant` deletes the pool. The issuer's JWKS endpoint disappears and
  the issuer leaves the registry, so a verifier that has not cached the
  pool's keys can no longer verify its outstanding tokens, and one that
  consults the registry as its allowlist stops trusting them at once. This is
  the topology's strongest property and MUST be demonstrated (§10 step 7).

### 7.2 `shared-pool`

- Pool created by the stack with a **mutable: false** custom attribute
  `tenantId` (string, 26 chars). Immutability is enforced by Cognito; the
  platform API never attempts to change it (moving a user between tenants is
  delete + create, by design). The app client's writable attributes MUST
  exclude `custom:tenantId` (P-3).
- The trigger copies `custom:tenantId` into the access token as `tenant_id`
  after confirming the tenant is `ACTIVE` (§8).
- E-mail is the username and usernames are pool-unique, so one person cannot
  exist in two tenants; `CreateUser` for an e-mail already present under a
  different `tenantId` → 409.

### 7.3 `shared-pool-multi-tenant`

- Pool created by the stack. `CreateTenant` creates group `t-<tenantId>`
  with the tenant name as description. No custom attribute.
- The trigger reads `request.groupConfiguration.groupsToOverride`, keeps the
  entries matching `^t-[0-9A-HJKMNP-TV-Z]{26}$`, strips the prefix, drops any
  tenant that is not `ACTIVE` in the registry (§8), sorts, and writes the
  result as the `tenants` array claim. Groups not matching the convention
  are ignored (reserved for the roles seam, §11).
- `AdminAddUserToGroup` is idempotent, so `AddMembership` is safe to retry.
- A user's groups are capped at 100 (service quota, not adjustable); the
  sample does not pre-check the cap and surfaces Cognito's error as 400.

---

## 8. Pre-Token-Generation Contract

The trigger is the sample (ADR-0004). It runs on every token issuance, sign-in and
refresh alike (Cognito invokes the pre-token-generation trigger for
`TokenGeneration_RefreshTokens` as well as the authentication sources), and
it is the only code that decides what tenant identity a token carries.

| Field | Requirement |
|---|---|
| Trigger version | `V2_0` (access-token customisation). |
| Input used | `userPoolId`, `request.userAttributes["custom:tenantId"]`, `request.groupConfiguration.groupsToOverride`. Nothing from `request.clientMetadata` (P-3). |
| Tenant lookup | 1: registry item for the event's `userPoolId` (§4.2). 2: registry item for `custom:tenantId`. 3: registry items for every `t-*` group (one batch read). The read is per invocation, uncached (N-9). |
| Status rule | 1, 2: tenant absent or not `ACTIVE` → throw. 3: drop every tenant that is absent or not `ACTIVE`; if nothing remains → throw. Cognito turns the throw into a failed sign-in or refresh (P-2). |
| Output | `response.claimsAndScopeOverrideDetails.accessTokenGeneration.claimsToAddOrOverride` = `{tenant_id}` (1, 2) or `{tenants: [...]}` (3). ID token untouched. No `claimsToSuppress`, no scope changes, no group overrides. |
| Failure mode | Any exception → Cognito fails the token request. The function MUST NOT swallow errors and return a token without the claim; a token without a tenant claim is a token the contract (P-6) does not allow. |
| Idempotency | Pure function of the event and the registry's current state; no writes. |

**R-11:** The trigger function's role MUST hold only `dynamodb:GetItem`,
`BatchGetItem`, and `Query` (for the GSI) on the registry, plus logging; it
MUST NOT hold any `cognito-idp` permission.

---

## 9. Non-Functional Requirements

| # | Requirement | Rationale |
|---|---|---|
| N-1 | Access token lifetime MUST be the Cognito minimum (5 minutes) in every pool the sample creates; refresh tokens 1 day. | Issued tokens cannot be withdrawn, so the lifetime is the offboarding bound (P-2); keep it short. Refresh re-runs the trigger, so a long refresh lifetime costs nothing in offboarding latency. Documented trade: more refresh traffic. |
| N-2 | *Retired.* | Was the resolver's registry cache TTL (ADR-0009). |
| N-3 | The registry table MUST have point-in-time recovery; sample uses `DESTROY` removal. | Operator-facing registry; in `pool-per-tenant` losing it orphans pools. |
| N-4 | Platform role scoped to `cognito-idp` actions on pools the sample created (resource tag `sample=tenant-identity` as the condition where the action supports resource ARNs; `CreateUserPool` has no resource, so it is the accepted account-wide action, documented in the threat model). | P-8: this is the hardening point of `pool-per-tenant`. |
| N-5 | *Retired.* | Was the application function's JWKS cache bound (ADR-0009). |
| N-6 | Structured logs; the platform function and the trigger log `tenantId`, `userId`, and the rule that refused an issuance, and never a token or a temporary password. | Synthetic data still deserves hygiene the reader will copy. |
| N-7 | The `/platform/*` stage MUST be throttled (reference: 10 rps / 20 burst). | `CreateTenant` in topology 1 creates account-wide resources; cap the rate of a leaked operator credential. |
| N-8 | Pools MUST be created with deletion protection **inactive** and tagged `sample=tenant-identity`. | Teardown must be total (P-4); a real deployment flips protection on and is told so in the hardening checklist. |
| N-9 | The trigger reads the registry on every invocation, with no cache. | Issuance happens at sign-in and at most once per access-token lifetime per session, so the read rate is low and a cache would only add a window in which a `DELETING` tenant still receives tokens. |

---

## 10. Acceptance Criteria

A correct implementation passes this scenario against real infrastructure,
**once per topology, with the same test code**, in one Region. The
integration test deploys the three stacks in parallel, runs the scenario
against each, and destroys them. "Verify" below means the test's own
verification of §3.2.

1. **Deploy inputs:** synth without `topology` fails naming the three values;
   synth with a misspelling fails the same way.
2. **Onboard:** `CreateTenant` A and B → both `ACTIVE`; `GetTenant` returns
   the topology-specific fields (pool ids and issuer for 1, `groupName` for
   3, neither for 2). Topology 1: two pools exist, each with the trigger
   attached.
3. **Users:** `CreateUser` u1 in A, u2 in B. Topology 2: `CreateUser` with
   u1's e-mail in B → 409. Topology 3: `AddMembership` u1 → B succeeds;
   topologies 1 and 2: `AddMembership` → 400 `UnsupportedInTopology`.
4. **Token contract (P-6):** `IssueToken` for u1 and u2; verify both access
   tokens. u1: `tenant_id = A` (1, 2; topology 1 also `iss` = tenant A's
   `issuer` from `GetTenant`) or `tenants = [A, B]` (3). u2: `tenant_id = B`
   or `tenants = [B]`. `sub` equals the Cognito user's `sub`. The ID tokens
   carry no `tenant_id` or `tenants` claim.
5. **Claim integrity (P-3):** topology 2: u1 calls `UpdateUserAttributes`
   on `custom:tenantId` with its own access token → rejected by Cognito, and
   a fresh token still says `A`. Topology 3: the operator creates a group
   `role-admin`, adds u1, re-issues → `tenants` unchanged. Topology 1: a
   user created directly in pool B (bypassing the platform API) still
   receives `tenant_id = B`, because the claim comes from the pool, not the
   caller.
6. **Refresh re-runs the trigger (3):** `RemoveMembership` u1 from B;
   `RefreshToken` with u1's refresh token → verify → `tenants = [A]`.
   `RemoveMembership` u1 from A → 409 (last tenant). `AddMembership` u1 → B
   again, refresh → `tenants = [A, B]`, so u1 enters step 7 as a
   multi-tenant user.
7. **Offboard (P-2):** `DeleteTenant` A. `RefreshToken` for u1: fails in
   topology 1 (pool gone) and 2 (user gone); succeeds in topology 3 with
   `tenants = [B]`, because u1 still belongs to B. u1's pre-deletion access
   token still verifies against keys cached before the deletion (the test
   asserts this and the README names the 5-minute bound); topology 1: the
   pool's JWKS URL now returns 404 and `DescribeUserPool` →
   `ResourceNotFound`. Topology 2: u1 is deleted. Topology 3: group `t-A` is
   gone, u1 and u2 still exist. `GetTenant` A → 404.
8. **`DELETING` window (P-2, unit level):** with a registry item in
   `DELETING`, the trigger throws for topologies 1 and 2 and omits the
   tenant for topology 3; with no item it does the same; with an unknown
   `userPoolId` (topology 1) it throws.
9. **Teardown:** `DeleteTenant` B; no pools (1) or groups and users (2, 3)
   tagged or prefixed by the test remain; `cdk destroy` leaves no stack, no
   parameters under `/application-plane/shared/identity/`, no log groups
   with the sample's prefix. Every platform operation has run at least once
   in every topology.

Plus unit-level assertions that: the provisioner is the only
topology-specific module (P-1); the trigger role's policy contains no
`cognito-idp:*` action and the trigger never reads `clientMetadata` (P-3,
P-8); the trigger returns the claim shape of §8 for each topology's event;
the registry never receives a user item (R-8).

---

## 11. Extension Seams (documented, not built)

| Extension | Seam |
|---|---|
| Token consumption | An API Gateway Cognito authoriser (REST API; `pool-per-tenant` lists every tenant pool ARN, onboarding appends to it), an HTTP API JWT authoriser (`shared-pool*` only, one issuer), or an in-function verifier that reads the registry as its issuer allowlist. Each reads the claims of P-6 unchanged. Deliberately not built (ADR-0009). |
| Roles within a tenant | Groups not matching `^t-` in topology 3 (`role-admin`, `role-member`); a second custom attribute in topology 2; per-pool groups in topology 1. Add a `roles` claim in the trigger. |
| Federation to a tenant's own IdP | Topology 1: an IdP per pool, the natural fit. Topologies 2 and 3: an IdP per tenant in the shared pool with attribute/group mapping, bounded by the 300-IdP quota. |
| Tenant-scoped tokens at sign-in (alternative to the multi-valued claim) | Pass the chosen tenant as `clientMetadata` to `InitiateAuth`; the trigger intersects it with the user's groups and emits a single `tenant_id`. Trades a per-request choice by the consumer for a per-session one, and relaxes P-3's "no `clientMetadata`" rule to "intersect, never trust". |
| Hosted UI / managed login | Add a domain and OAuth flows to the app client; nothing in the trigger changes. |
| Async onboarding | Wrap `CreateTenant` in the control-plane sample's workflow when onboarding grows beyond Cognito calls (e.g. also provisioning tenant storage). |
| Control-plane mounting | A `scripts/control-plane/` lifecycle set that calls `CreateTenant`/`DeleteTenant` so this sample runs as a cell's identity component. |
| Audit trail of platform operations | CloudTrail already records every `cognito-idp` call; a first-class audit table would duplicate it (P-5 spirit). |

---

## 12. Reading Order for Implementers

1. §1.3 and §2 (what the three topologies trade and the principles).
2. §8, the pre-token-generation contract; it is the sample.
3. §7, the per-topology mechanics behind it.
4. §4 and §5.1, registry and platform API.
5. §10, then build the integration test first.
6. `adr/README.md` for the decisions and their rejected alternatives.

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
controls the user pool (the vendor, P-8), and every service downstream
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

**The sample stops at the token, with one exception.** Its product is a
Cognito access token that carries tenant identity, issued and withdrawn by
the identity provider. How a service verifies that token and scopes a
request to the tenant it names is the consumer's design, not this sample's
(§1.2). The one consumer the sample builds is its own tenant-admin API,
`/tenant/users`, where a tenant admin manages the users of their own tenant
(ADR-0014, ADR-0007). That route is identity work, and it shows the narrowed
token in use. The integration test verifies every token it asserts on with
a standard library, to prove that the claim is present, correct, and the
same shape in every topology.

**A token for every tenant is too much token for one.** In
`shared-pool-multi-tenant` a user's access token names every tenant the user
belongs to. A service that acts for one tenant needs a token that names that
tenant and nothing more. If the service receives the multi-tenant token, a
leak from that service exposes every tenant the user belongs to, and the
service has to be trusted to pick the right one. The sample therefore issues
**narrowed tokens** through an OAuth 2.0 Token Exchange (RFC 8693) endpoint.
The client that holds the user's refresh token exchanges it for an access
token that names one tenant and a subset of scopes, before it calls the
service. Cognito signs the narrowed token, so it has the same issuer and
verifies the same way (P-10, ADR-0009). A tenant admin uses the same
exchange to obtain the admin scope for one tenant before calling the tenant
API (P-11).

### 1.1 The deployment model

This is an **application-plane** sample: it is the identity layer a deployed
multi-tenant application uses to authenticate tenant users and to tell every
downstream service which tenant they act for. It assumes a **pooled
application plane** (one deployment serves many tenants) and shows how the
identity boundary can still be silo (`pool-per-tenant`) or pool
(`shared-pool*`) independently of the compute boundary. It complements the
`control-plane` sample, which deliberately treats tenant identity as an
application-plane concern (control-plane ADR-004).

Two actor classes exist, and the spec uses these two words for them
throughout:

- **Vendor** (the operator): the party that runs the application. It onboards
  tenants and manages users and memberships through the **platform API**.
- **Tenant** (the customer): an organisation served by the application. Its
  people are **tenant users**; they authenticate against Cognito and receive
  tokens that carry their tenant. What they call with those tokens is outside
  the sample. Some of them are **tenant admins**: they create, read, update,
  delete, and list the users of their own tenant through the tenant API
  (ADR-0014). The vendor creates a tenant's first admin with the tenant and
  keeps full rights to every user.

### 1.2 What this sample is NOT

Out of scope, deliberately:

- **Token consumption by services.** Verifying a token and scoping a request to the tenant
  it names belongs to the service or gateway that receives it: an API Gateway
  Cognito authoriser, a JWT authoriser, or an in-function verifier are all
  valid consumers, and the registry gives a `pool-per-tenant` consumer its
  issuer allowlist (§4.1). None of them is built here (seam in §11). The `/tenant/*` authoriser
  (ADR-0007) guards the sample's own route; it is not a general consumer.
  The token-exchange endpoint (§5.4) is not a consumer: its subject token is
  a refresh token, which Cognito itself validates.
- **A login UI.** Managed login / hosted UI, federation to tenant IdPs (SAML,
  OIDC, social), passwordless, MFA. Tokens are obtained with a server-side
  password flow for demonstration; the claims do not depend on how the token
  was issued.
- **Roles beyond tenant admin.** One role is built: tenant admin, which
  grants user management in one tenant (ADR-0015). Further roles and
  permissions are an extension seam (§11). Every user holds the two sample
  API scopes (§8.1).
- **Delegation and audience narrowing.** RFC 8693's `act` claim and
  `audience` parameter are seams (§11). The exchange narrows tenant and
  scopes only.
- **The vendor's own identity.** The vendor authenticates to the platform API
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
| What token exchange narrows (§5.4) | scopes (the tenant is already single) | scopes (the tenant is already single) | tenant and scopes |
| Tenant admin role (ADR-0015) | group `admin-<id>` in the tenant's pool | group `admin-<id>` | group `admin-<id>`, per tenant |
| Groups per tenant | one (`admin-`) | two (`t-` for listing, `admin-`) | two (`t-`, `admin-`) |
| Hard ceilings (defaults, per Region) | 1,000 user pools (adjustable to 10,000) | 40,000,000 users per pool; 50 custom attributes; 10,000 groups per pool, so 5,000 tenants | 10,000 groups per pool, so 5,000 tenants; 100 groups per user; 5,000 total changes in pre-token-generation output |
| Where the tenant lives in the token | `iss` (and `tenant_id`, which MUST agree) | `tenant_id` claim from `custom:tenantId` | `tenants` claim from `cognito:groups` |

Quota figures are from the Cognito quotas page at the time of writing; the
README MUST link the page rather than restate figures as permanent.

---

## 2. Guiding Principles

These principles generated every decision in the design. When this spec is
silent on a detail, resolve it by applying these principles; they are the
spec's extension mechanism and the facts the ADRs appeal to.

### P-1. One contract, three strategies

The vendor sees one platform API and every consumer sees one token
contract (P-6), regardless of topology. Everything topology-specific lives
behind one strategy interface, the **provisioner**: what onboarding a tenant,
creating a user, changing a membership, and offboarding a tenant mean in this
topology, plus how the pre-token-generation trigger finds the tenant(s) for
an event (§8). An implementation MUST NOT let topology-specific branches leak
into handlers, the data model, or the API model. The test of the principle:
the integration scenario (§10) runs unchanged against all three stacks.

### P-2. The token is the product; offboarding is enforced at issuance

The sample builds no request path for the services tenant users call, so it
MUST NOT invent a status check for them. Offboarding is enforced where identity is issued, by the identity provider
and the trigger that shapes its tokens (ADR-0008):

1. `DeleteTenant` flips the tenant to `DELETING` in the registry before
   touching Cognito (R-11).
2. The pre-token-generation trigger refuses to add a `DELETING` or absent
   tenant to any token, on sign-in **and on refresh** (§8). A user whose only
   tenant is gone cannot obtain a new token; a multi-tenant user obtains one
   without that tenant.
3. The provisioner then removes what the tenant owned in Cognito: the pool,
   or the group and the users whose only tenant it was (P-4).

Access tokens already issued remain valid until they expire; the bound is the
access token lifetime (N-1, 5 minutes). The README MUST state that bound and
MUST say that a consumer needing a tighter one adds a status check of its
own, which is a consumer decision outside this sample. The tenant API is the
one exception: its authoriser reads the registry on every request and
refuses a tenant that is not `ACTIVE`, so `/tenant/*` stops at once
(ADR-0007).

### P-3. Tenant identity is a claim the caller cannot choose

The tenant a token names MUST be set by the vendor through the platform API
and MUST reach the token only through Cognito: the issuing pool, an
attribute, or a group. Nothing the tenant user controls MAY influence it. In
`shared-pool` the attribute is created **immutable** and excluded from the app
client's writable attributes, so the user can neither change it nor set it at
sign-up (self sign-up is off in every pool, R-5). In `shared-pool-multi-tenant`
groups are admin-only by construction. The trigger MUST NOT derive a tenant
or a scope from `clientMetadata` or any other caller-supplied input. It MAY
read a narrowing request from `clientMetadata`, and only to remove tenants
and scopes the user already holds, never to add one (P-10, ADR-0010).
Without an exchange, a token carries every membership. Narrowing to one
tenant is the client's request, made through the exchange (§5.4).
The tenant API takes the tenant from the verified token, never from the
path, body, or query (P-11).

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
a Cognito call, which is acceptable for a platform API that the vendor calls
rarely.

### P-6. Minimal claims, stable shape

The access token carries exactly one tenant claim added by the pre-token-
generation trigger: `tenant_id` (string; topologies 1 and 2, and every
narrowed token) or `tenants` (array of strings; topology 3 without
narrowing). The trigger also sets the sample scopes in `scope` (§8.1).
Nothing else is added: no names, no roles, no e-mail. The claims go into the **access** token, not the ID token, because
the access token is what a client presents to an API; the ID token is for the
client itself. This is the **token contract**, the one thing a consumer may
rely on across topologies:

| Topology | Claim | Value | Also true |
|---|---|---|---|
| `pool-per-tenant` | `tenant_id` | the tenant's ULID | `iss` is the tenant's pool; the registry maps one to the other and the two MUST agree |
| `shared-pool` | `tenant_id` | the tenant's ULID | |
| `shared-pool-multi-tenant` | `tenants` | sorted array of ULIDs, length ≥ 1 | only groups named `t-<ULID>` contribute |
| narrowed, any topology (§5.4) | `tenant_id` | the requested tenant's ULID | no `tenants` claim; `scope` is exactly the requested scopes; `aws.cognito.signin.user.admin` removed |

`sub`, `username`, `iss`, `client_id`, `token_use`, and `exp` are Cognito's
own and are not altered. A single-tenant consumer SHOULD require
`tenant_id` and the scope it serves, which rejects every un-narrowed
topology-3 token. `tenant-admin/users` appears only on narrowed tokens
(ADR-0015).

### P-7. Explicit deploy-time choice, fail fast

`topology` is a required CDK context value with exactly three accepted
strings. Synthesis MUST fail with a message listing the accepted values if it
is missing or misspelled. A topology is never inferred, defaulted, or
switched at runtime (ADR-0001).

### P-8. Least privilege expressed as role asymmetry

The platform function creates and deletes user pools, groups, and users; the
trigger function reads the registry and nothing else. They MUST be separate
functions with separate roles: the trigger role MUST NOT hold any
`cognito-idp:*` action (R-14), and the platform API MUST NOT be reachable
with a tenant-user token (IAM only, ADR-0005). In `pool-per-tenant` the
platform role necessarily holds `cognito-idp:CreateUserPool` and
`DeleteUserPool`, which are account-wide actions; this is the documented hardening point of that topology (N-3). The
tenant-user function (R-8) holds Cognito user actions only, with no pool
or group lifecycle action, and the tenant authoriser (R-9) reads the
registry only. In `shared-pool*` the tenant-user role can still reach every
user in the pool, because Cognito has no IAM boundary per tenant inside a
pool. That function's tenant isolation is therefore enforced in code by
R-12, and the threat model records it.

### P-9. Say what each topology costs

Each topology trades isolation for operational simplicity in a different
place. The README MUST carry the comparison in §1.3 of this spec, kept true
after implementation, including the service quotas that bound each design,
because the quotas are the first thing a real deployment hits.

### P-10. Narrow before you call, and narrowing never widens

A client that acts for one tenant MUST be able to obtain a token that names
only that tenant and only the scopes the call needs. Cognito issues the
narrowed token through the pre-token-generation trigger, so it has the same
issuer and signature as every other token, and no second signer is trusted
(ADR-0009). The request to narrow is caller input and therefore untrusted.
The trigger intersects it with what the user already holds, and refuses
unless the result is exactly what was asked for (ADR-0010). So the exchange
endpoint holds no privilege: anyone holding a refresh token can send the same
request to Cognito directly, and gets nothing the refresh token did not
already grant. The narrowed token is an access token only. No refresh token
carrying the narrowing is issued, so a service that receives it cannot extend
it past its lifetime (N-1).

### P-11. Two front doors, one provisioner

Users are managed through two doors that run the same provisioner
operations. The vendor's door, `/platform/*`, names the tenant in the path,
is authorised by IAM, and reaches every tenant. The tenant admin's door,
`/tenant/users`, takes the tenant from a verified, narrowed token that
carries `tenant-admin/users` for that tenant, and reaches only that tenant
(ADR-0014). Both doors run the R-12 membership check before acting on a
user, so a username from another tenant is not found through either. The
vendor's rights are a superset of the tenant admin's, so the vendor can
recover a tenant that has locked itself out.

---

## 3. System Shape

### 3.1 Required components

| # | Component | Requirement |
|---|---|---|
| R-1 | **HTTP API** | One API Gateway HTTP API, generated from the interface model (Smithy), three route families: `/platform/*` with IAM authorisation (ADR-0005); `POST /oauth2/token`, the token-exchange endpoint, with no gateway authoriser because the refresh token is the credential (§5.4, ADR-0011); and `/tenant/*` with the tenant authoriser (R-9, ADR-0007). No other routes. |
| R-2 | **Platform function** | Implements the platform API through the topology's provisioner. Role per P-8. |
| R-3 | **Tenant registry** | One DynamoDB table (§4). Point-in-time recovery on; `DESTROY` removal for the sample. |
| R-4 | **Pre-token-generation function** | Cognito Lambda trigger, version 2 event (`V2_0`), adds the claim(s) and scopes of P-6 to the access token, enforces tenant status (P-2), and applies narrowing requests (P-10, §8; ADR-0003). Attached to every pool the sample creates. Pools MUST use the **Essentials** feature plan (the default for new pools); access-token customisation is not available on Lite without advanced security features. |
| R-5 | **User pool(s)** | `shared-pool*`: exactly one pool created by the stack. `pool-per-tenant`: zero pools at deploy time; one pool, one app client, and the trigger attachment per tenant at onboarding. Every pool: self sign-up off, admin-create only, e-mail as username, access token lifetime 5 minutes (N-1), refresh token rotation off (ADR-0009), no hosted UI domain. |
| R-6 | **Parameter publication** | The stack publishes `/application-plane/shared/identity/{apiUrl,topology}` and, for `shared-pool*`, `/application-plane/shared/identity/userPoolId` and `appClientId`, so the sample mounts into the `control-plane` sample's shared namespace. |
| R-7 | **Token-exchange function** | Implements `POST /oauth2/token` (§5.4). It parses the form and calls `GetTokensFromRefreshToken` with the narrowing request in `ClientMetadata`. It returns the access token only and discards the ID token. Its role holds logging permissions only, no `cognito-idp` or DynamoDB action, because `GetTokensFromRefreshToken` is authorised by the refresh token, not by IAM (P-10). |
| R-8 | **Tenant-user function** | Implements `/tenant/users` (§5.2) through the topology's provisioner, with the tenant taken only from the authoriser context. Its role holds `AdminCreateUser`, `AdminGetUser`, `AdminDeleteUser`, `AdminAddUserToGroup`, `AdminRemoveUserFromGroup`, `AdminListGroupsForUser`, `ListUsers`, and `ListUsersInGroup`, scoped as N-3, plus registry reads. It holds no `CreateUserPool`, `DeleteUserPool`, `CreateGroup`, or `DeleteGroup` (P-8). |
| R-9 | **Tenant authoriser** | HTTP API Lambda authoriser on `/tenant/*`, with result caching off. Verifies the access token as ADR-0007 states, refuses a tenant that is not `ACTIVE`, and passes `tenantId` and `sub` as context. Its role reads the registry and nothing else. |

### 3.2 Caller and identity model

- **Vendor → platform API:** SigV4 with any principal the deployer grants
  `execute-api:Invoke` on `/platform/*`. The sample grants the deploying
  principal nothing implicitly; the integration test signs with its own
  credentials and the stack's resource policy allows the account.
- **Tenant user → Cognito:** sign-in against the topology's pool yields access,
  ID, and refresh tokens; the access token carries the tenant (P-6). The only endpoint in the sample
  that accepts it is `/tenant/*`, and only a narrowed one (P-11).
- **Client → token exchange:** the client that holds a tenant user's
  refresh token posts it to `POST /oauth2/token` with the tenant and the
  scopes it needs, and receives a narrowed access token (§5.4). In the
  sample, the client is the integration test.
- **Tenant admin → tenant API:** the admin's client exchanges the admin's
  refresh token with `resource=<tenant>` and `scope=tenant-admin/users`
  (§5.4), then calls `/tenant/users` with the narrowed token as a bearer
  token (§5.2).
- **Sign-in in the sample:** `ADMIN_USER_PASSWORD_AUTH` through
  `AdminInitiateAuth` from the platform function (`POST
  /platform/tenants/{tenantId}/users/{username}/token`) **for the
  demonstration only**, so the integration test can obtain real Cognito
  tokens without a browser (ADR-0006). This route MUST be documented as a
  test aid and the README's hardening checklist MUST say to remove it in
  production.
- **Verification in the test:** the integration test verifies every token it
  asserts on with a JWKS-based library (reference: `aws-jwt-verify`) against
  the issuer named by the registry (topology 1) or the published pool
  parameters (topologies 2, 3), the pool's app client, and
  `token_use == "access"`. This is test code, not sample code, and the README MUST say so. The
  tenant authoriser (R-9) is sample code and verifies the same way.

### 3.3 Deployment inputs

| Context key | Required | Values / default | Effect |
|---|---|---|---|
| `topology` | yes | `pool-per-tenant` \| `shared-pool` \| `shared-pool-multi-tenant` | selects the provisioner (P-7) |

Synthesis MUST fail on an unknown `topology` with the accepted values in the
message. The stack name MUST embed the topology
(`TenantIdentity-<topology>`) so all three can coexist in one account and
Region, which the integration test relies on. No other input exists.

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

**R-10:** No user, membership, credential, or token material is ever written
to the table (P-5).

**R-11:** `DeleteTenant` MUST flip `status` to `DELETING` with a conditional
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
vendor-scale, not user-scale). An implementation MAY add a status GSI; it
MUST NOT add a user item type to make listing users cheaper (P-5).

---

## 5. API Surface

Defined first in Smithy; OpenAPI, server SDK, and gateway wiring are
generated from the model. Operations bound to a resource lifecycle use the AWS
verbs: `Create`, `Get`, `Update`, `Delete`, `List` (and `Put` for
create-or-replace), so `CreateMembership`, not `AddMembership`. Operations
outside the lifecycle (`IssueToken`, `RefreshToken`, the token exchange) keep a verb
that says what they do.

### 5.1 Platform operations (`/platform`, IAM)

| Operation | Method / path | Effect by topology |
|---|---|---|
| `CreateTenant` | `POST /platform/tenants` `{name, adminEmail}` → 201 `{tenant, admin}` | 1: create pool + client + trigger + group `admin-<id>`, write registry. 2, 3: create groups `t-<id>` and `admin-<id>`, write registry. All: then `CreateUser` for `adminEmail` with `admin: true`; `admin` is that User with its temporary password. If this step fails, the tenant is `ACTIVE` with no admin, and the vendor retries with `CreateUser`. |
| `GetTenant` | `GET /platform/tenants/{tenantId}` | registry read |
| `ListTenants` | `GET /platform/tenants?nextToken=` | registry scan |
| `DeleteTenant` | `DELETE /platform/tenants/{tenantId}` → 204 | R-11, then: 1: delete pool. 2: delete users with `custom:tenantId=<id>`. 3: delete users whose only group is `t-<id>`, remove the group from the rest, delete the group. |
| `CreateUser` | `POST /platform/tenants/{tenantId}/users` `{email, admin?}` → 201 User | 1: `AdminCreateUser` in the tenant's pool. 2: `AdminCreateUser` with `custom:tenantId`, then `AdminAddUserToGroup` `t-<id>`. 3: `AdminCreateUser` (if absent) + `AdminAddUserToGroup` `t-<id>`. All: `admin: true` also adds the user to `admin-<id>`. Returns a temporary password only in the response, only for a new Cognito user, and never logs it. |
| `DeleteUser` | `DELETE /platform/tenants/{tenantId}/users/{username}` → 204 | 1, 2: `AdminDeleteUser`. 3: remove from `t-<id>` and `admin-<id>`; delete the user if no `t-*` group remains. |
| `GetUser` | `GET /platform/tenants/{tenantId}/users/{username}` → 200 User | `AdminGetUser`, plus `AdminListGroupsForUser` for the admin flag. |
| `ListUsers` | `GET /platform/tenants/{tenantId}/users?nextToken=` → 200 `{users, nextToken}` | 1: `ListUsers` on the tenant's pool. 2, 3: `ListUsersInGroup` `t-<id>`. |
| `UpdateUser` | `PATCH /platform/tenants/{tenantId}/users/{username}` `{admin}` → 200 User | add the user to, or remove them from, `admin-<id>`. |
| `CreateMembership` | `PUT /platform/tenants/{tenantId}/users/{username}/membership` → 204 | 3: `AdminAddUserToGroup`. 1, 2: 400 `UnsupportedInTopology`. |
| `DeleteMembership` | `DELETE /platform/tenants/{tenantId}/users/{username}/membership` → 204 | 3: `AdminRemoveUserFromGroup`; 409 if it is the user's last tenant (use `DeleteUser`). 1, 2: 400 `UnsupportedInTopology`. |
| `IssueToken` (test aid) | `POST /platform/tenants/{tenantId}/users/{username}/token` `{password}` → 200 `{accessToken, idToken, refreshToken, expiresIn}` | `AdminSetUserPassword` (permanent) then `AdminInitiateAuth` with `ADMIN_USER_PASSWORD_AUTH` against the topology's pool. §3.2. |
| `RefreshToken` (test aid) | `POST /platform/tenants/{tenantId}/users/{username}/token/refresh` `{refreshToken}` → 200 `{accessToken, idToken, expiresIn}` | `AdminInitiateAuth` with `REFRESH_TOKEN_AUTH`, so the test can show that refresh re-runs the trigger (P-2, §10 steps 6 and 9). Same labelling as `IssueToken`. |

A User is `{username, email, admin, status, createdAt}`: `status` is
Cognito's user status, and `admin` is membership of `admin-<id>`. A User
never says which other tenants the user belongs to.

**R-12:** `GetUser`, `UpdateUser`, `DeleteUser`, `DeleteMembership`,
`IssueToken`, `RefreshToken`, and every `/tenant/users/{username}`
operation MUST first check, through the provisioner, that the user
belongs to `{tenantId}`: 1: the user exists in the tenant's pool. 2:
`custom:tenantId` equals `{tenantId}`. 3: the user is in `t-<tenantId>`.
If not, the call fails with `ResourceNotFoundError` (404) and changes
nothing. `CreateUser`, `CreateTenantUser`, and `CreateMembership` are exempt: adding a user to a
tenant is the vendor's intent (ADR-0013).

Platform mutations are **synchronous**. The slowest, creating a user pool, is
seconds, not minutes; a 202/polling model would add machinery without adding
a capability (contrast control-plane P-8, where builds take minutes).

### 5.2 Tenant operations (`/tenant`, tenant authoriser)

The tenant is the authoriser's `tenantId` (R-9), never a request field (P-3,
P-11). Every call needs a narrowed access token that carries
`tenant-admin/users` (ADR-0015). Each operation runs the same provisioner
operation as its platform twin, with the same per-topology effects.

| Operation | Method / path | Platform twin |
|---|---|---|
| `CreateTenantUser` | `POST /tenant/users` `{email, admin?}` → 201 User | `CreateUser` |
| `GetTenantUser` | `GET /tenant/users/{username}` → 200 User | `GetUser` |
| `ListTenantUsers` | `GET /tenant/users?nextToken=` → 200 `{users, nextToken}` | `ListUsers` |
| `UpdateTenantUser` | `PATCH /tenant/users/{username}` `{admin}` → 200 User | `UpdateUser` |
| `DeleteTenantUser` | `DELETE /tenant/users/{username}` → 204 | `DeleteUser` |

**R-13:** A tenant admin MUST NOT demote or delete themselves.
`UpdateTenantUser` with `admin: false`, or `DeleteTenantUser`, where
`{username}` is the caller (`sub` from the authoriser) → 409. So the tenant
API always leaves at least one admin; only the vendor can remove the last.

`CreateMembership` and `DeleteMembership` stay vendor-only. From a tenant's
view, `CreateTenantUser` and `DeleteTenantUser` are the only membership
changes, and only for its own tenant. In topology 3, `CreateTenantUser` for
an e-mail that already has a Cognito user adds that user to the tenant, as
`CreateUser` does, and returns no temporary password (threat model T-21).

### 5.3 Error model

| Error | HTTP | Triggers |
|---|---|---|
| `ValidationError` | 400 | malformed input; `UnsupportedInTopology` |
| `ResourceNotFoundError` | 404 | unknown tenant or user; a user who does not belong to the path's tenant (R-12) |
| `ConflictError` | 409 | tenant `DELETING` on mutation; removing a user's last membership; e-mail already exists in a shared pool for a different tenant (topology 2); a tenant admin demoting or deleting themselves (R-13) |
| `InternalServerError` | 500 | everything else |

401 and 403 on `/platform/*` are API Gateway's own (IAM). On `/tenant/*`, API
Gateway answers 401 for a missing token and 403 when the authoriser refuses,
with no reason in the body. The sample's functions emit neither.
`POST /oauth2/token` does not use this model; it returns RFC 6749 §5.2
errors (§5.4).

### 5.4 Token exchange (`POST /oauth2/token`, no authoriser)

RFC 8693 §2, with Cognito as the signer (ADR-0009). Request body
`application/x-www-form-urlencoded` (ADR-0011):

| Parameter | Requirement |
|---|---|
| `grant_type` | `urn:ietf:params:oauth:grant-type:token-exchange` |
| `client_id` | the app client that issued the refresh token: the shared client (2, 3) or the tenant's client from `GetTenant` (1) |
| `subject_token` | the user's refresh token |
| `subject_token_type` | `urn:ietf:params:oauth:token-type:refresh_token`; any other value → `invalid_request` |
| `requested_token_type` | optional; if present MUST be `urn:ietf:params:oauth:token-type:access_token` |
| `resource` | `urn:tenant-identity:tenant:<ULID>`, at most one. Required in topology 3. In 1 and 2, if omitted, it defaults to the user's only tenant. |
| `scope` | required; space-separated, non-empty subset of §8.1 |
| `audience`, `actor_token`, `actor_token_type` | not supported → `invalid_request` |

Behaviour: validate the form, then call `GetTokensFromRefreshToken` with
`ClientMetadata` = the §8.2 keys. The trigger decides. The function then
checks that the trigger was asked (ADR-0012): it decodes the returned
access token's payload, without verifying it, because it came from Cognito
in this call. It refuses unless `token_use` is `access`, `tenant_id` equals
the requested tenant (when one was requested), there is no `tenants` claim,
and the `scope` set equals the requested set. A narrowed token never holds
`aws.cognito.signin.user.admin`, so an un-narrowed one always fails the
scope check. On a mismatch the token is discarded.

Success, 200, `Cache-Control: no-store`:
`{access_token, issued_token_type:
"urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer",
expires_in, scope}`. No `refresh_token`.

Errors, `{error, error_description}`, 400 unless marked:

| `error` | When |
|---|---|
| `invalid_request` | malformed form, a missing or unsupported parameter |
| `unsupported_grant_type` | any other `grant_type` |
| `invalid_target` | the trigger refused the tenant: not held, not `ACTIVE`, or absent (message prefix `invalid_target`) |
| `invalid_scope` | the trigger refused the scopes (prefix `invalid_scope`) |
| `invalid_grant` | anything else Cognito rejects: an expired, revoked, or foreign refresh token, or an unknown client |
| `server_error` (500) | Cognito returned a token that does not match the request (ADR-0012); logged by rule name, never with the token |

`error_description` is fixed text per code and never echoes Cognito's
message or the token.

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
  R-11); tokens already issued expire within the access token lifetime (N-1).
- A narrowed token names exactly the requested tenant and scopes, and only
  when the user holds them. Otherwise no token is issued (P-10). This holds
  whether the request comes through `POST /oauth2/token` or straight to
  Cognito.
- A tenant admin reaches exactly the users of their own tenant; the vendor
  reaches every user (P-11, R-12).
- Clean teardown: `cdk destroy` after deleting all tenants leaves no pools,
  groups, users, parameters, or log groups with the sample's prefix.
- Parameters under `/application-plane/shared/identity/*` (R-6).

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
  consults the registry as its allowlist stops trusting them at once. This is the topology's strongest property and MUST be demonstrated (§10 step 9).
- `CreateTenant` also creates group `admin-<tenantId>` in the tenant's pool,
  so the admin rule is the same in every topology (ADR-0015).

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
- Every user is also in group `t-<tenantId>`, for listing only (ADR-0014).
  The trigger does not use it for the claim, which comes from the attribute
  (P-3). `CreateTenant` creates `t-<id>` and `admin-<id>`.

### 7.3 `shared-pool-multi-tenant`

- Pool created by the stack. `CreateTenant` creates groups `t-<tenantId>`
  (the tenant name as description) and `admin-<tenantId>`. No custom attribute.
- The trigger reads `request.groupConfiguration.groupsToOverride`, keeps the
  entries matching `^t-[0-9A-HJKMNP-TV-Z]{26}$`, strips the prefix, drops any
  tenant that is not `ACTIVE` in the registry (§8), sorts, and writes the
  result as the `tenants` array claim. Groups matching neither `t-` nor `admin-` are ignored (reserved for further
  roles, §11).
- Narrowing (§8.2) picks one entry of that set and emits it as `tenant_id`
  instead of `tenants`.
- `AdminAddUserToGroup` is idempotent, so `CreateMembership` is safe to retry.
- A user's groups are capped at 100 (service quota, not adjustable); the
  sample does not pre-check the cap and surfaces Cognito's error as 400.

---

## 8. Pre-Token-Generation Contract

The trigger is the sample (ADR-0003, ADR-0008, ADR-0010). It runs on every
token issuance, sign-in and refresh alike (Cognito invokes the
pre-token-generation trigger for
`TokenGeneration_RefreshTokens` as well as the authentication sources), and
it is the only code that decides what tenant identity a token carries.

| Field | Requirement |
|---|---|
| Trigger version | `V2_0` (access-token customisation). |
| Input used | `userPoolId`, `request.userAttributes["custom:tenantId"]`, `request.groupConfiguration.groupsToOverride`, and from `request.clientMetadata` only the §8.2 keys, only to narrow (P-3, P-10). |
| Tenant lookup | 1: registry item for the event's `userPoolId` (§4.2). 2: registry item for `custom:tenantId`. 3: registry items for every `t-*` group (one batch read). The read is per invocation, uncached (N-9). |
| Status rule | 1, 2: tenant absent or not `ACTIVE` → throw. 3: drop every tenant that is absent or not `ACTIVE`; if nothing remains → throw. Cognito turns the throw into a failed sign-in or refresh (P-2). |
| Output | `accessTokenGeneration.claimsToAddOrOverride` = `{tenant_id}` (1, 2, and every narrowed token) or `{tenants: [...]}` (3, un-narrowed). `accessTokenGeneration.scopesToAdd` = the §8.1 API scopes, or exactly the requested ones when narrowed; `tenant-admin/users` only ever when narrowed (§8.1). A narrowed token also gets `scopesToSuppress = ["aws.cognito.signin.user.admin"]`. ID token untouched. No `claimsToSuppress`, no group overrides. |
| Failure mode | Any exception → Cognito fails the token request. The function MUST NOT swallow errors and return a token without the claim; a token without a tenant claim is a token the contract (P-6) does not allow. |
| Idempotency | Pure function of the event and the registry's current state; no writes. |

### 8.1 Sample scopes

A fixed, deploy-time set, a constant in the trigger, not an input (P-7):

| Scope | Held for tenant T by | Un-narrowed tokens |
|---|---|---|
| `tenant-api/read`, `tenant-api/write` | every user of T; they name a fictional downstream API | carry both |
| `tenant-admin/users` | members of group `admin-<T>` (ADR-0015) | never carry it |

Further roles that decide who holds which API scope are the §11 seam.

### 8.2 Narrowing request

Two `clientMetadata` keys, set by the token-exchange function or by any
direct caller of `GetTokensFromRefreshToken`:

| Key | Value |
|---|---|
| `tenant_identity_narrow_tenant` | a ULID |
| `tenant_identity_narrow_scope` | space-separated scopes |

If either key is present, the token is narrowed and both rules apply:

1. The tenant set is computed as in the table above, with status rules
   applied. The requested tenant MUST be in it. Otherwise the trigger throws
   `invalid_target: ...`. In topologies 1 and 2, a missing tenant key means
   the user's only tenant. In topology 3 it is an `invalid_target`.
2. The requested scopes MUST be a non-empty subset of the scopes the user
   holds for the requested tenant (§8.1). Otherwise the trigger throws
   `invalid_scope: ...`.

The result is exactly the request, or nothing. The trigger never widens, and
no other `clientMetadata` key is read (ADR-0010).

**R-14:** The trigger function's role MUST hold only `dynamodb:GetItem`,
`BatchGetItem`, and `Query` (for the GSI) on the registry, plus logging; it
MUST NOT hold any `cognito-idp` permission.

---

## 9. Non-Functional Requirements

| # | Requirement | Rationale |
|---|---|---|
| N-1 | Access token lifetime MUST be the Cognito minimum (5 minutes) in every pool the sample creates; refresh tokens 1 day. | Issued tokens cannot be withdrawn, so the lifetime is the offboarding bound (P-2); keep it short. Refresh re-runs the trigger, so a long refresh lifetime costs nothing in offboarding latency. Documented trade: more refresh traffic. |
| N-2 | The registry table MUST have point-in-time recovery; sample uses `DESTROY` removal. | Vendor-facing registry; in `pool-per-tenant` losing it orphans pools. |
| N-3 | Platform role scoped to `cognito-idp` actions on pools the sample created (resource tag `sample=tenant-identity` as the condition where the action supports resource ARNs; `CreateUserPool` has no resource, so it is the accepted account-wide action, documented in the threat model). | P-8: this is the hardening point of `pool-per-tenant`. |
| N-4 | Structured logs; the platform function and the trigger log `tenantId`, `userId`, and the rule that refused an issuance, and never a token or a temporary password. | Synthetic data still deserves hygiene the reader will copy. |
| N-5 | The `/platform/*` stage MUST be throttled (reference: 10 rps / 20 burst). | `CreateTenant` in topology 1 creates account-wide resources; cap the rate of a leaked vendor credential. |
| N-6 | `POST /oauth2/token` MUST be throttled separately from `/platform/*` (reference: 20 rps / 40 burst). Its function MUST NOT log the refresh token, the issued token, or Cognito's error message. | The route is unauthenticated at the gateway; cap the cost of abuse against Cognito's request-rate quotas. |
| N-7 | `/tenant/*` MUST be throttled separately (reference: 10 rps / 20 burst). Its authoriser MUST NOT cache results. The tenant-user function logs `tenantId`, the caller's `sub`, and the operation, never a token or a temporary password. | Each call changes identity: cap the damage of a leaked admin token, and keep offboarding immediate on this route (P-2). |
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
2. **Onboard:** `CreateTenant` A (`adminEmail` a1) and B (`adminEmail` b1)
   → both `ACTIVE`, each response carrying its admin and a temporary
   password; `GetTenant` returns
   the topology-specific fields (pool ids and issuer for 1, `groupName` for
   3, neither for 2). Topology 1: two pools exist, each with the trigger
   attached.
3. **Users:** `CreateUser` u1 in A, u2 in B. Topology 2: `CreateUser` with
   u1's e-mail in B → 409. Topology 3: `CreateMembership` u1 → B succeeds;
   topologies 1 and 2: `CreateMembership` → 400 `UnsupportedInTopology`.
   Every topology (R-12): `DeleteUser` and `IssueToken` for tenant A with
   u2's username → 404, and u2 still exists and still signs in.
4. **Token contract (P-6):** `IssueToken` for u1 and u2; verify both access
   tokens. u1: `tenant_id = A` (1, 2; topology 1 also `iss` = tenant A's
   `issuer` from `GetTenant`) or `tenants = [A, B]` (3). u2: `tenant_id = B`
   or `tenants = [B]`. `sub` equals the Cognito user's `sub`. The ID tokens
   carry no `tenant_id` or `tenants` claim.
5. **Claim integrity (P-3):** topology 2: u1 calls `UpdateUserAttributes`
   on `custom:tenantId` with its own access token → rejected by Cognito, and
   a fresh token still says `A`. Topology 3: the vendor creates a group
   `role-admin`, adds u1, re-issues → `tenants` unchanged. Topology 1: a
   user created directly in pool B (bypassing the platform API) still
   receives `tenant_id = B`, because the claim comes from the pool, not the
   caller.
6. **Refresh re-runs the trigger (3):** `DeleteMembership` u1 from B;
   `RefreshToken` with u1's refresh token → verify → `tenants = [A]`.
   `DeleteMembership` u1 from A → 409 (last tenant). `CreateMembership` u1 → B
   again, refresh → `tenants = [A, B]`, so u1 enters step 9 as a
   multi-tenant user.
7. **Narrowing (P-10), all topologies.** Exchange u1's refresh token with
   `scope=tenant-api/read`, plus `resource=A` (required in 3), and verify.
   The result has `tenant_id = A`, no `tenants` claim,
   `scope = "tenant-api/read"`, and no `aws.cognito.signin.user.admin`.
   It has the same `iss` as u1's other tokens. Topology 2: that token's
   `GetUser` call is rejected by Cognito. Then check the refusals:
   - `resource=A` with u2's refresh token (u2 holds only B):
     `invalid_target`, in every topology.
   - `scope=tenant-api/admin`: `invalid_scope`.
   - no `resource` in topology 3: `invalid_target`.
   - `subject_token_type` = access token: `invalid_request`.
   Bypass the endpoint: call `GetTokensFromRefreshToken` directly with u2's
   refresh token and the §8.2 keys naming A. Cognito fails the request, which
   proves the trigger enforces the rule, not the endpoint. A plain
   `RefreshToken` afterwards returns u1's un-narrowed token again, so the
   exchange did not change the session.
8. **Tenant admin (P-11), all topologies.** `IssueToken` for a1, then
   exchange with `resource=A` and `scope=tenant-admin/users`. With that
   token: `CreateTenantUser` u3 → 201; `GetTenantUser` u3 → `admin=false`;
   `ListTenantUsers` → a1, u1, u3, and neither u2 nor b1; `UpdateTenantUser`
   u3 `admin=true`, then `admin=false`; `DeleteTenantUser` u3 → 204, then
   platform `GetUser` u3 → 404. Then check the refusals:
   - a1's un-narrowed access token, and a narrowed one with only
     `tenant-api/read`: 403 from the authoriser.
   - u1 asks the exchange for `tenant-admin/users` on A: `invalid_scope`.
   - Topology 3: after `CreateMembership` a1 → B, a1 asks for
     `tenant-admin/users` on B: `invalid_scope`, because a1 is a member of B
     but not its admin.
   - `GetTenantUser` and `DeleteTenantUser` for u2 (tenant B): 404, and u2
     still exists (R-12).
   - `DeleteTenantUser` a1, and `UpdateTenantUser` a1 `admin=false`: 409
     (R-13).
   - Topology 3: b1's `GetTenantUser` for u1 (in A and B) returns a User
     that does not mention A.
9. **Offboard (P-2):** `DeleteTenant` A. a1's narrowed admin token from step
   6b, not yet expired, → 403 on `ListTenantUsers` at once (R-9). `RefreshToken` for u1: fails in
   topology 1 (pool gone) and 2 (user gone); succeeds in topology 3 with
   `tenants = [B]`, because u1 still belongs to B. u1's pre-deletion access
   token still verifies against keys cached before the deletion (the test
   asserts this and the README names the 5-minute bound); topology 1: the
   pool's JWKS URL now returns 404 and `DescribeUserPool` →
   `ResourceNotFound`. Topology 3: exchanging u1's refresh token for
   `resource=A` → `invalid_target`, and for `resource=B` → success. Topology
   2: u1 is deleted. Topology 3: group `t-A` is
   gone, u1 and u2 still exist. `GetTenant` A → 404.
10. **`DELETING` window (P-2, unit level):** with a registry item in
   `DELETING`, the trigger throws for topologies 1 and 2 and omits the
   tenant for topology 3; with no item it does the same; with an unknown
   `userPoolId` (topology 1) it throws.
11. **Teardown:** `DeleteTenant` B; no pools (1) or groups and users (2, 3)
   tagged or prefixed by the test remain; `cdk destroy` leaves no stack, no
   parameters under `/application-plane/shared/identity/`, no log groups
   with the sample's prefix. Every platform operation, every tenant operation, and the token-exchange endpoint have run at least once in every topology.

Plus unit-level assertions that: the provisioner is the only
topology-specific module (P-1); the trigger role's policy contains no
`cognito-idp:*` action and the trigger reads no `clientMetadata` key outside §8.2 (P-3,
P-8); the trigger returns the claim shape of §8 for each topology's event;
the registry never receives a user item (R-10); narrowing never widens: for
any `clientMetadata`, the output tenants are a subset of the user's `ACTIVE`
tenants and the output scopes a subset of §8.1 (property test, ADR-0010); the
trigger's error prefixes match §5.4; the token-exchange role holds no
`cognito-idp` or `dynamodb` action (R-7); the exchange function returns `server_error` and no token when Cognito's
token is un-narrowed, names another tenant, or carries other scopes
(ADR-0012); the provisioner refuses per-user operations for a user outside
the path's tenant in every topology (R-12); the tenant-user function reads the tenant only from the authoriser context,
never from the path, body, or query (P-11); the authoriser refuses an ID
token, a token from another pool or app client, a token with `tenants`, a
token without `tenant-admin/users`, and a tenant that is not `ACTIVE`
(ADR-0007); the trigger never puts `tenant-admin/users` on an un-narrowed
token, and puts it on a narrowed one only for a member of `admin-<T>`
(ADR-0015); the tenant-user role holds no pool or group lifecycle action
(R-8); the form parser rejects every
RFC 8693 parameter not listed in §5.4.

---

## 11. Extension Seams (documented, not built)

| Extension | Seam |
|---|---|
| Token consumption | An API Gateway Cognito authoriser (REST API; `pool-per-tenant` lists every tenant pool ARN, onboarding appends to it), an HTTP API JWT authoriser (`shared-pool*` only, one issuer), or an in-function verifier that reads the registry as its issuer allowlist. Each reads the claims of P-6 unchanged. Not built for the services tenant users call; the `/tenant/*` authoriser (ADR-0007) is the pattern to copy. |
| Roles beyond tenant admin | More per-tenant groups next to `admin-<id>` (for example `billing-<id>`), each mapped to a scope that only narrowed tokens carry, as ADR-0015 does for admin. |
| Federation to a tenant's own IdP | Topology 1: an IdP per pool, the natural fit. Topologies 2 and 3: an IdP per tenant in the shared pool with attribute/group mapping, bounded by the 300-IdP quota. |
| Narrowing at sign-in | Pass the §8.2 keys to `InitiateAuth` to narrow the session's first token. Not built: exchange (§5.4) narrows per call with no new sign-in (ADR-0009, Option 4). |
| Delegation (`act`, RFC 8693 §4.1) and audience narrowing | A service exchanging a token it received, to act for the user downstream, needs an access-token subject and a signer of its own. Out of scope by ADR-0009; a managed exchange (for example AgentCore Identity on-behalf-of) is the natural fit. |
| Hosted UI / managed login | Add a domain and OAuth flows to the app client; nothing in the trigger changes. |
| Async onboarding | Wrap `CreateTenant` in the control-plane sample's workflow when onboarding grows beyond Cognito calls (e.g. also provisioning tenant storage). |
| Control-plane mounting | A `scripts/control-plane/` lifecycle set that calls `CreateTenant`/`DeleteTenant` so this sample runs as a cell's identity component. |
| Audit trail of platform operations | CloudTrail already records every `cognito-idp` call; a first-class audit table would duplicate it (P-5 spirit). |

---

## 12. Reading Order for Implementers

1. §1.3 and §2 (what the three topologies trade and the principles).
2. §8, the pre-token-generation contract; it is the sample. §8.2 and §5.4
   for narrowing; §5.2 and P-11 for the tenant admin.
3. §7, the per-topology mechanics behind it.
4. §4 and §5.1, registry and platform API.
5. §10, then build the integration test first.
6. `adr/README.md` for the decisions and their rejected alternatives.
